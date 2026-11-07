#!/usr/bin/env python3
"""Pinned PasoFi upgrade of an existing Compose installation; preflight by default."""
import argparse
import copy
from contextlib import contextmanager, ExitStack
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import urlsplit

APPS = ("identity", "prepaid-access", "network", "notification", "assistant")
UPDATABLE = (*APPS, "web")
PROTECTED = ("postgres", "radius", "radius-api")
LABEL = "com.docker.compose."
NODE_IMAGE = "node:24.22.1-alpine"
RETAINED_ID = Path("/home/ubuntu/pamofi/production/cluster-system-id")
SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
               "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=10",
               "-o", "ServerAliveCountMax=2", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no",
               "-o", "PermitLocalCommand=no", "-o", "ControlMaster=no", "-o", "ControlPath=none",
               "-o", "RequestTTY=no"]
CONFIG_BINDS = {
    "/opt/pamofi/entrypoint.mjs": "entrypoint.mjs",
    "/opt/pamofi/apply-grants.mjs": "apply-grants.mjs",
    "/opt/pamofi/role-policies.json": "role-policies.json",
    "/etc/nginx/conf.d/default.conf": "gateway/internal.conf",
    "/etc/nginx/pamofi/internal-common.conf": "gateway/internal-common.conf",
    "/opt/pamofi/vercel-entrypoint.sh": "gateway/vercel-entrypoint.sh",
    "/opt/pasofi/hotspot-portal.conf": "gateway/hotspot-portal.conf",
}


class Refusal(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def run(argv, *, cwd=None, log=None):
    """Never echo command output: Compose/inspect output can contain credentials."""
    result = subprocess.run(argv, cwd=cwd, text=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if log is not None:
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(result.stdout + result.stderr)
        os.chmod(log, 0o600)
    if result.returncode:
        raise Refusal("A required command failed; no command output was printed. "
                      + ("Review the private operation log." if log else
                         "Check Docker/Compose access and the supplied files locally."))
    return result.stdout


def load_manifest(path, archive):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    require(set(data) == {"schema", "commit", "archive_sha256", "services", "migrations"},
            "Manifest keys must be schema, commit, archive_sha256, services, migrations.")
    require(data["schema"] == 1 and re.fullmatch(r"[0-9a-f]{40}", data["commit"] or ""),
            "Manifest requires schema 1 and a full lowercase Git commit SHA.")
    require(re.fullmatch(r"[0-9a-f]{64}", data["archive_sha256"] or ""),
            "Manifest requires an archive SHA-256.")
    for key, allowed in (("services", UPDATABLE), ("migrations", APPS)):
        value = data[key]
        require(isinstance(value, list) and value and all(isinstance(x, str) for x in value)
                and len(value) == len(set(value)) and set(value) <= set(allowed),
                "Manifest contains an empty, duplicate, or unsupported service list.")
    require(set(data["migrations"]) <= set(data["services"]),
            "Every migration must belong to an updated application service.")
    require(set(data["services"]) & set(APPS) == set(data["migrations"]),
            "Each updated application must run its owned migration service.")
    rollout_phases(data["services"])
    digest = hashlib.sha256()
    with open(archive, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    require(digest.hexdigest() == data["archive_sha256"], "Release archive hash mismatch.")
    return data


def rollout_phases(services):
    """The manifest has no proof that an unselected dependency is compatible."""
    require("prepaid-access" not in services or "network" in services,
            "Updating prepaid-access requires the selected network dependency.")
    require("web" not in services or {"network", "prepaid-access"} <= set(services),
            "Updating web requires the selected network and prepaid-access dependencies.")
    phases = [[name] for name in ("network", "prepaid-access") if name in services]
    phases.append([name for name in services if name not in ("network", "prepaid-access")]
                  + ["internal-gateway", "gateway"])
    return phases


def verify_rollout_phase(containers, completed, phase, expected_images, log):
    for name in completed:
        container = containers.get(name, {})
        require(container.get("Image") == expected_images[name],
                "A selected runtime image differs from the pinned build; stopped before downstream updates.")
        state = container.get("State") or {}
        require(state.get("Running"), "An updated runtime stopped; stopped before downstream updates.")
        if name in UPDATABLE:
            require((state.get("Health") or {}).get("Status") == "healthy",
                    "An updated application is not healthy; stopped before downstream updates.")
    for name in phase:
        if name not in ("network", "prepaid-access"):
            continue
        # Probe the exact inspected container, never a caller-selected URL or a public router.
        script = ("Promise.all([['/health/live','ok'],['/health/ready','ready']].map(async ([path,status])=>{"
                  "const response=await fetch('http://127.0.0.1:3000'+path,{redirect:'error',signal:AbortSignal.timeout(2500)});"
                  "if(response.status!==200)throw new Error();const value=await response.json();"
                  "if(value.status!==status||(path==='/health/live'&&value.service!==" + json.dumps(name) + "))throw new Error();"
                  "})).then(()=>process.exit(0)).catch(()=>process.exit(1));")
        run(["docker", "exec", containers[name]["Id"], "node", "-e", script], log=log)


def extract_source(archive, destination, commit):
    """Accept the complete git archive produced by the qualified release packager."""
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        require(bundle.pax_headers.get("comment") == commit,
                "Archive Git commit does not match the manifest; use git archive.")
        require(len(members) < 100000 and sum(m.size for m in members) < 1024**3,
                "Release archive exceeds the bounded source-package limit.")
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and ".." not in path.parts
                    and path.parts and path.parts[0] == "pasofi"
                    and (member.isfile() or member.isdir()),
                    "Archive contains an unsafe path, link, or unsupported entry.")
        # All members were checked before extracting anything; no symlinks are accepted.
        if hasattr(tarfile, "data_filter"):
            bundle.extractall(destination, members=members, filter="data")
        else:  # Python 3.9 installations without the backported extraction filters.
            bundle.extractall(destination, members=members)
    source = Path(destination) / "pasofi"
    require((source / "pasofi-backend/infra/production/compose.yaml").is_file(),
            "Release is missing the production source tree.")
    return source


def inspect_project(project=None):
    ids = run(["docker", "ps", "-aq", "--filter", "label=" + LABEL + "project"]).split()
    require(ids, "No existing Compose containers were found; this tool cannot install a new stack.")
    containers = [container for container in json.loads(run(["docker", "inspect", *ids]))
                  if container["Config"]["Labels"].get(LABEL + "oneoff", "False").lower() != "true"]
    if project is None:
        candidates = {c["Config"]["Labels"].get(LABEL + "project") for c in containers
                      if c["Config"]["Labels"].get(LABEL + "service") == "prepaid-access"}
        require(len(candidates) == 1, "Select the existing project explicitly with --project.")
        project = candidates.pop()
    require(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project or ""), "Unexpected Compose project name.")
    selected = [c for c in containers if c["Config"]["Labels"].get(LABEL + "project") == project
                and c["Config"]["Labels"].get(LABEL + "oneoff", "False").lower() != "true"]
    services = {}
    for container in selected:
        service = container["Config"]["Labels"].get(LABEL + "service")
        require(service not in services, "Multiple containers for one service make this upgrade ambiguous.")
        services[service] = container
    require({"postgres", "prepaid-access", "gateway", "internal-gateway"} <= set(services),
            "Required existing production services are missing.")
    return project, services


def discover_stack(containers):
    labels = [c["Config"]["Labels"] for c in containers.values()]
    directories = {x.get(LABEL + "project.working_dir", "") for x in labels}
    require(len(directories) == 1 and "" not in directories,
            "Compose working-directory labels are missing or inconsistent.")
    directory = Path(directories.pop())
    require(directory.is_dir(), "Recorded Compose working directory is unavailable.")
    stacks = []
    for label in labels:
        files = tuple(label.get(LABEL + "project.config_files", "").split(","))
        require(files and all(files), "A container has no complete Compose file labels.")
        require(all(Path(f).is_absolute() and Path(f).is_file() for f in files),
                "A recorded Compose file is missing; do not substitute a base-only stack.")
        stacks.append(files)
    # A newer superset is safe only if every older stack is an ordered subsequence.
    def subsequence(older, newer):
        iterator = iter(newer)
        return all(any(item == candidate for candidate in iterator) for item in older)
    candidates = {s for s in stacks if all(subsequence(other, s) for other in stacks)}
    require(len(candidates) == 1, "Recorded Compose stacks disagree; reconcile their ordered overlays first.")
    return directory, list(candidates.pop())


def retained_database_identity():
    """Read the existing independent record; never adopt a live database ID."""
    message = ("The retained PostgreSQL installation record is missing or unsafe. "
               "Automatic deployment cannot replace it with the live database identity.")
    try:
        descriptor = os.open(RETAINED_ID, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            owners = {0, os.geteuid()}
            # A privileged operator can read the existing installation owner's
            # private record without changing its ownership or adopting a live ID.
            if os.geteuid() == 0:
                parent = RETAINED_ID.parent.lstat()
                require(stat.S_ISDIR(parent.st_mode) and parent.st_mode & 0o022 == 0, message)
                owners.add(parent.st_uid)
            require(stat.S_ISREG(info.st_mode) and info.st_size <= 128
                    and info.st_mode & 0o022 == 0 and info.st_uid in owners, message)
            value = handle.read(129).decode("ascii").strip()
            require(re.fullmatch(r"[0-9]{10,30}", value) is not None, message)
            return value
    except (OSError, UnicodeError):
        raise Refusal(message) from None


def discover_existing_inputs(containers):
    """Recover original env-file order only from complete consistent labels."""
    message = ("The original environment-file order is not recorded consistently on every existing container. "
               "Automatic deployment stopped without guessing environment files.")
    records = []
    for container in containers.values():
        value = container["Config"]["Labels"].get(LABEL + "project.environment_file")
        require(isinstance(value, str) and 0 < len(value) <= 32768, message)
        files = value.split(",")
        require(0 < len(files) <= 32 and len(files) == len(set(files)), message)
        require(all(1 < len(path) <= 4096 and path.startswith("/") and not path.startswith("//")
                    and all(character.isprintable() for character in path)
                    and not {".", ".."}.intersection(path.split("/"))
                    and Path(path).is_file() for path in files), message)
        records.append(files)
    require(records and all(record == records[0] for record in records), message)
    return list(records[0]), retained_database_identity()


def recheck_discovered_inputs(args, containers):
    if getattr(args, "baseline", None):
        before = args._baseline_record
        loaded = load_service_baseline(args, args._baseline_manifest, before["project"], containers)
        require(args._baseline_record == before and loaded[5] == args.expected_database_id,
                "The reviewed per-service baseline changed during deployment.")
    elif getattr(args, "discover_existing", False):
        environment_files, database_id = discover_existing_inputs(containers)
        require(environment_files == args.env_file and database_id == args.expected_database_id,
                "The retained installation inputs changed during deployment; stopped before migration.")


def compose_command(project, directory, files, env_files):
    result = ["docker", "compose", "--project-name", project,
              "--project-directory", str(directory), "--profile", "*"]
    for path in env_files:
        result.extend(["--env-file", str(path)])
    for path in files:
        result.extend(["-f", str(path)])
    return result


def resolved_compose(base):
    # Compose config re-escapes every dollar after JSON serialization, including
    # keys (Docker Compose v2.40.3 cmd/compose/config.go escapeDollarSign). Decode
    # that serialization once; Docker inspect and all comparisons use runtime
    # values. An unexpected format must not silently weaken those comparisons.
    serialized = run(base + ["config", "--format", "json"])
    require("$" not in serialized.replace("$$", ""),
            "Compose JSON has unexpected dollar escaping; configuration cannot be verified.")
    return json.loads(serialized.replace("$$", "$"))


def object_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_digest(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 8 * 1024 * 1024,
            "A recorded baseline input is missing, linked or too large.")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_mounts(container):
    # Docker can enumerate its MountPoints map in a different order on each
    # inspect. Bind every mount attribute, but not that incidental list order.
    mounts = container.get("Mounts")
    require(type(mounts) is list and all(type(mount) is dict
            and type(mount.get("Destination")) is str and mount["Destination"] for mount in mounts),
            "Docker mount observations need complete destinations.")
    destinations = [mount["Destination"] for mount in mounts]
    require(len(destinations) == len(set(destinations)),
            "Docker mount observations contain duplicate destinations.")
    return copy.deepcopy(sorted(mounts, key=lambda mount: mount["Destination"]))


def runtime_digest(container):
    # Hashes bind a private observation without copying environment values into
    # the provenance manifest. This also detects docker-update/network drift.
    return object_digest({**{key: container.get(key) for key in
                           ("Id", "Image", "Config", "HostConfig", "NetworkSettings")},
                          "Mounts": canonical_mounts(container)})


def origin_record(container):
    labels = container["Config"]["Labels"]
    service = labels.get(LABEL + "service")
    require(type(service) is str and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,100}", service),
            "A baseline service has an invalid recorded name.")
    directory = labels.get(LABEL + "project.working_dir", "")
    config = labels.get(LABEL + "project.config_files", "")
    environment = labels.get(LABEL + "project.environment_file")
    config_hash = labels.get(LABEL + "config-hash", "")
    require(re.fullmatch(r"[0-9a-f]{64}", config_hash or "") is not None,
            "Every baseline service needs its recorded Compose configuration hash.")
    require(Path(directory).is_absolute() and Path(directory).is_dir(),
            "A baseline service has no existing absolute working directory.")

    def paths(value):
        require(type(value) is str and 0 < len(value) <= 32768,
                "A baseline service has incomplete ordered file labels.")
        items = value.split(",")
        require(0 < len(items) <= 32 and len(items) == len(set(items))
                and all(Path(item).is_absolute() and not {".", ".."}.intersection(item.split("/"))
                        and all(character.isprintable() for character in item) for item in items),
                "A baseline service has invalid ordered file labels.")
        return [{"path": item, "sha256": file_digest(item)} for item in items]

    files = paths(config)
    if environment:
        env_files, mode = paths(environment), "recorded-files"
    else:
        # Historical isolated updates used complete JSON models. No .env file
        # is guessed: the exact rendered hash and all runtime checks must match.
        require(len(files) == 1 and Path(files[0]["path"]).suffix == ".json",
                "Missing environment labels require one existing self-contained JSON model.")
        raw = json.loads(Path(files[0]["path"]).read_text())
        require(type(raw) is dict and type(raw.get("services")) is dict,
                "The historical JSON model is not a complete Compose model.")
        require(not any(key in raw for key in ("include", "extends"))
                and all(type(value) is dict and not any(key in value for key in ("env_file", "extends"))
                        for value in raw["services"].values()),
                "A self-contained JSON origin cannot load unrecorded configuration files.")
        env_files, mode = [], "self-contained-json"
    return {"service": service, "container_id": container["Id"], "image_id": container["Image"],
            "config_hash": config_hash, "runtime_sha256": runtime_digest(container),
            "working_directory": directory, "compose_files": files,
            "environment_files": env_files, "environment_mode": mode}


def render_origin(project, record, supplemental_environment=None):
    files = [item["path"] for item in record["compose_files"]]
    env_files = [item["path"] for item in record["environment_files"]]
    # Explicit /dev/null also prevents Compose loading an unrelated implicit .env.
    env_files = env_files or ["/dev/null"]
    if supplemental_environment:
        env_files.append(supplemental_environment["path"])
    base = compose_command(project, record["working_directory"], files, env_files)
    model = resolved_compose(base)
    name = record["service"]
    require(model.get("name") == project and name in model.get("services", {}),
            "An origin does not describe its observed project and service.")
    hashes = run(base + ["config", "--hash", name]).strip().splitlines()
    require(hashes == [name + " " + record["config_hash"]],
            "An origin's rendered service hash differs from its running Compose label.")
    image = model["services"][name].get("image")
    require(type(image) is str and image, "An origin has no recorded application image.")
    require(run(["docker", "image", "inspect", "--format", "{{.Id}}", image]).strip() == record["image_id"],
            "An origin's image reference no longer identifies its running image.")
    return model


def merge_baseline_service(combined, model, name):
    require(name in model.get("services", {}) and name not in combined["services"],
            "A baseline service definition is missing or duplicated.")
    service = copy.deepcopy(model["services"][name])
    combined["services"][name] = service
    references = {"networks": list(service.get("networks", {})),
                  "volumes": [item["source"] for item in service.get("volumes", []) if item["type"] == "volume"],
                  "secrets": [item["source"] for item in service.get("secrets", [])],
                  "configs": [item["source"] for item in service.get("configs", [])]}
    for category, names in references.items():
        for key in names:
            require(key in model.get(category, {}), "A baseline resource definition is missing.")
            value = model[category][key]
            existing = combined.setdefault(category, {})
            require(key not in existing or existing[key] == value,
                    "Observed service origins disagree about a shared resource; baseline refused.")
            existing[key] = copy.deepcopy(value)


def verify_migration_database(service, migration, model, containers):
    """A borrowed job must use this live app's database and separate owner role."""
    message = "The selected migration does not match its live service database authority."
    require(migration.get("entrypoint") == ["node", "/opt/pamofi/entrypoint.mjs"],
            "A selected migration must execute the pinned production entrypoint.")
    for target in ("/opt/pamofi/entrypoint.mjs", "/opt/pamofi/apply-grants.mjs", "/opt/pamofi/role-policies.json"):
        mounts = [item for item in migration.get("volumes", []) if item.get("target") == target]
        require(len(mounts) == 1 and mounts[0].get("type") == "bind" and mounts[0].get("read_only") is True,
                "A selected migration is missing a required read-only pinned configuration bind.")
    # The URL's hostname must resolve through the retained Docker network. A
    # borrowed job cannot redirect it with a hosts file, link or custom resolver.
    require(not any(migration.get(key) for key in
                    ("extra_hosts", "network_mode", "links", "external_links", "dns", "dns_search", "dns_opt")),
            "A selected migration overrides retained database hostname resolution.")
    resolver_paths = ("/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf")
    for category in ("volumes", "secrets", "configs"):
        for item in migration.get(category, []):
            target = item.get("target", item.get("source", ""))
            if category == "secrets" and not target.startswith("/"):
                target = "/run/secrets/" + target
            require(not any(target == path or path.startswith(target.rstrip("/") + "/")
                            for path in resolver_paths),
                    "A selected migration mounts a database hostname resolution override.")
    current = containers[service]
    environment = runtime_env(current)
    migrate_env = migration.get("environment", {})
    prefix = environment.get("PAMOFI_ROLE_PREFIX", "pamofi")
    suffix = service.replace("-", "_")
    require(re.fullmatch(r"[a-z][a-z0-9_]{0,24}", prefix or "")
            and migrate_env.get("PAMOFI_ROLE_PREFIX", "pamofi") == prefix
            and all(environment.get(key) == migrate_env.get(key) == "production" for key in ("APP_ENV", "NODE_ENV"))
            and environment.get("PAMOFI_SERVICE") == migrate_env.get("PAMOFI_SERVICE") == service, message)
    runtime_target = environment.get("DATABASE_URL_FILE")
    migration_target = migrate_env.get("MIGRATION_DATABASE_URL_FILE")
    require(type(runtime_target) is str and type(migration_target) is str
            and not environment.get("DATABASE_URL") and not migrate_env.get("MIGRATION_DATABASE_URL"), message)
    runtime_mounts = [item for item in current.get("Mounts", []) if item["Destination"] == runtime_target]
    require(len(runtime_mounts) == 1 and not runtime_mounts[0].get("RW"), message)
    runtime_file = runtime_mounts[0]["Source"]
    migration_files = []
    for item in migration.get("secrets", []):
        target = item.get("target", item["source"])
        if not target.startswith("/"):
            target = "/run/secrets/" + target
        if target == migration_target:
            migration_files.append(model.get("secrets", {}).get(item["source"], {}).get("file"))
    require(len(migration_files) == 1 and type(migration_files[0]) is str, message)
    migration_file = migration_files[0]

    def database_url(filename, role):
        try:
            path = Path(filename)
            require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 65536, message)
            value = re.sub(r"\r?\n$", "", path.read_bytes().decode("utf-8"))
            require(value and not any(character in value for character in ("\0", "\r", "\n")), message)
            parsed = urlsplit(value)
            require(parsed.scheme in ("postgres", "postgresql") and parsed.username == role
                    and parsed.password and parsed.hostname and not parsed.query and not parsed.fragment
                    and parsed.path == "/" + prefix + "_" + suffix, message)
            return parsed.hostname, parsed.port or 5432, parsed.path
        except (OSError, ValueError, UnicodeError):
            raise Refusal(message) from None

    runtime_role, migrate_role, owner = (prefix + "_" + suffix + ending for ending in ("_runtime", "_migrate", "_owner"))
    endpoint = database_url(runtime_file, runtime_role)
    require(database_url(migration_file, migrate_role) == endpoint and endpoint[1] == 5432, message)
    postgres = containers["postgres"]
    runtime_networks = set(current.get("NetworkSettings", {}).get("Networks", {}))
    migration_networks = {model.get("networks", {}).get(key, {}).get("name") for key in migration.get("networks", {})}
    postgres_networks = postgres.get("NetworkSettings", {}).get("Networks", {})
    reachable = runtime_networks & migration_networks & set(postgres_networks)
    hosts = set()
    for network in reachable:
        observed = postgres_networks[network]
        hosts.update(observed.get("Aliases") or [])
        hosts.update(filter(None, (observed.get("IPAddress"), observed.get("GlobalIPv6Address"))))
    require(endpoint[0] in hosts, message)
    bootstrap = runtime_env(postgres).get("POSTGRES_USER", "")
    require(re.fullmatch(r"[a-z][a-z0-9_]{0,62}", bootstrap) is not None, message)
    database = prefix + "_" + suffix
    # All SQL identifiers here are derived from validated service/prefix values;
    # no URL, credential or user-supplied SQL is passed to the command line.
    sql = ("SELECT CASE WHEN pg_get_userbyid(d.datdba)='" + owner + "' "
           "AND NOT o.rolcanlogin AND NOT o.rolsuper AND m.rolcanlogin AND NOT m.rolsuper "
           "AND NOT m.rolcreatedb AND NOT m.rolcreaterole AND r.rolcanlogin AND NOT r.rolsuper "
           "AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND pg_has_role(m.oid,o.oid,'MEMBER') "
           "THEN 'matched' ELSE 'mismatch' END FROM pg_database d "
           "JOIN pg_roles o ON o.rolname='" + owner + "' "
           "JOIN pg_roles m ON m.rolname='" + migrate_role + "' "
           "JOIN pg_roles r ON r.rolname='" + runtime_role + "' "
           "WHERE d.datname='" + database + "'")
    require(run(["docker", "exec", "--user", "postgres", postgres["Id"], "psql", "-X", "-U", bootstrap,
                 "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql]).strip() == "matched", message)
    return {"runtime_file": runtime_file, "runtime_sha256": file_digest(runtime_file),
            "migration_file": migration_file, "migration_sha256": file_digest(migration_file)}


def origin_environment_records(containers, paths):
    require(type(paths) is dict and set(paths) <= set(containers)
            and all(type(value) is str for value in paths.values()),
            "Supplemental environments must name an actually observed service and a private file.")
    return {name: {"path": str(private_baseline_path(path)), "sha256": file_digest(path)}
            for name, path in paths.items()}


def baseline_observation(manifest, project, containers, migration_origins, origin_environment_paths=None):
    require(type(migration_origins) is dict and set(migration_origins) == set(manifest["migrations"])
            and all(value in containers for value in migration_origins.values()),
            "Each owned migration must select an actually observed service origin.")
    database_id = retained_database_identity()
    database_identity(containers["postgres"], database_id)
    origin_environment_paths = origin_environment_paths or {}
    environments = origin_environment_records(containers, origin_environment_paths)
    records, models = {}, {}
    for name, container in sorted(containers.items()):
        record = origin_record(container)
        try:
            model = render_origin(project, record, environments.get(name))
            validate_existing(model, containers, [], only=[name])
        except Refusal as error:
            raise Refusal("Baseline service " + name + ": " + str(error)) from None
        records[name], models[name] = record, model
    combined = {"name": project, "services": {}}
    for name in sorted(containers):
        merge_baseline_service(combined, models[name], name)
    databases = {}
    for service in manifest["migrations"]:
        model = models[migration_origins[service]]
        name = service + "-migrate"
        require(name in model.get("services", {}),
                "An owned migration is absent from its selected origin; review --migration-origin mappings.")
        migration = model["services"][name]
        require(migration.get("command") == ["migrate"]
                and migration.get("environment", {}).get("PAMOFI_SERVICE") == service,
                "A selected migration is not the matching service-owned migration command.")
        databases[service] = verify_migration_database(service, migration, model, containers)
        merge_baseline_service(combined, model, name)
    validate_existing(combined, containers, manifest["services"])
    # Inputs or container identity changing while models are rendered cannot
    # produce a reviewable baseline, even if the last service rendered cleanly.
    _, current = inspect_project(project)
    require(set(current) == set(containers)
            and all(origin_record(current[name]) == record for name, record in records.items()),
            "The installation changed during baseline verification.")
    require(retained_database_identity() == database_id,
            "The retained database record changed during baseline verification.")
    require(origin_environment_records(current, origin_environment_paths) == environments,
            "A supplemental origin environment changed during baseline verification.")
    return {"schema": 1, "release_commit": manifest["commit"], "project": project,
            "database_id": database_id, "origins": records, "migration_origins": migration_origins,
            "migration_databases": databases, "origin_environments": environments}, combined


def literal_compose(value):
    # Executable Compose JSON needs exactly one escape of runtime dollar values.
    # Keys stay literal because Compose interpolates values, not mapping keys.
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, list):
        return [literal_compose(item) for item in value]
    if isinstance(value, dict):
        return {key: literal_compose(item) for key, item in value.items()}
    return value


def private_baseline_path(path, *, new=False):
    path = Path(path).absolute()
    parent = path.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_mode & 0o077 == 0
            and parent.st_uid in (0, os.geteuid()), "Use an existing private baseline directory (mode 0700).")
    if new:
        require(not path.exists() and not path.is_symlink(), "A baseline output already exists; do not overwrite it.")
    else:
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_mode & 0o077 == 0
                and info.st_uid in (0, os.geteuid()) and info.st_size <= 8 * 1024 * 1024,
                "The baseline input must be a private regular file.")
    return path


def capture_service_baseline(args, manifest, project, containers):
    path = private_baseline_path(args.capture_baseline, new=True)
    model_path = private_baseline_path(str(path) + ".compose.json", new=True)
    empty_env = private_baseline_path(str(path) + ".empty.env", new=True)
    migrations = {name: name for name in manifest["migrations"]}
    seen = set()
    for item in getattr(args, "migration_origin", []):
        name, separator, origin = item.partition("=")
        require(separator and name in migrations and name not in seen and origin in containers,
                "Use each --migration-origin once as owned-service=observed-service.")
        seen.add(name)
        migrations[name] = origin
    environments = {}
    for item in getattr(args, "origin_env", []):
        name, separator, path_value = item.partition("=")
        require(separator and name in containers and name not in environments and path_value,
                "Use each --origin-env once as observed-service=private-environment-file.")
        environments[name] = path_value
    record, model = baseline_observation(manifest, project, containers, migrations, environments)
    created = []
    try:
        with empty_env.open("x", encoding="utf-8"):
            pass
        created.append(empty_env)
        empty_env.chmod(0o600)
        with model_path.open("x", encoding="utf-8") as handle:
            created.append(model_path)
            json.dump(literal_compose(model), handle, indent=2)
            handle.write("\n")
        model_path.chmod(0o600)
        base = compose_command(project, path.parent, [str(model_path)], [str(empty_env)])
        require(resolved_compose(base) == model,
                "The combined baseline model did not preserve the verified Compose values.")
        record["model_sha256"] = file_digest(model_path)
        with path.open("x", encoding="utf-8") as handle:
            created.append(path)
            json.dump(record, handle, indent=2)
            handle.write("\n")
        path.chmod(0o600)
    except Exception:
        for created_path in reversed(created):
            created_path.unlink(missing_ok=True)
        raise
    print("Per-service baseline captured after configuration and runtime verification.", flush=True)
    print("Baseline SHA-256: " + file_digest(path) + ".", flush=True)
    print("No application, database or protected service was changed.", flush=True)


def load_service_baseline(args, manifest, project, containers):
    path = private_baseline_path(args.baseline)
    model_path = private_baseline_path(str(path) + ".compose.json")
    empty_env = private_baseline_path(str(path) + ".empty.env")
    require(empty_env.read_bytes() == b"", "The baseline's empty interpolation file changed.")
    record = json.loads(path.read_text())
    require(type(record) is dict and set(record) == {"schema", "release_commit", "project", "database_id",
                                                    "origins", "migration_origins", "migration_databases", "origin_environments", "model_sha256"}
            and type(record["schema"]) is int and record["schema"] == 1,
            "The per-service baseline manifest is invalid.")
    require(record["release_commit"] == manifest["commit"] and record["project"] == project,
            "The baseline is for a different release or Compose project.")
    require(file_digest(model_path) == record["model_sha256"], "The private combined baseline model changed.")
    require(type(record["origin_environments"]) is dict
            and all(type(value) is dict and set(value) == {"path", "sha256"}
                    for value in record["origin_environments"].values()),
            "The supplemental origin environment records are invalid.")
    observed, model = baseline_observation(manifest, project, containers, record["migration_origins"],
        {name: value["path"] for name, value in record["origin_environments"].items()})
    require({key: value for key, value in record.items() if key != "model_sha256"} == observed,
            "The reviewed per-service baseline no longer matches the installation.")
    base = compose_command(project, path.parent, [str(model_path)], [str(empty_env)])
    require(resolved_compose(base) == model,
            "The private combined model differs from its verified service origins.")
    files = {str(path), str(model_path), str(empty_env)}
    for origin in record["origins"].values():
        files.update(item["path"] for item in origin["compose_files"] + origin["environment_files"])
    for database in record["migration_databases"].values():
        files.update(database[key] for key in ("runtime_file", "migration_file"))
    files.update(value["path"] for value in record["origin_environments"].values())
    args._baseline_record = record
    args._baseline_manifest = manifest
    return path.parent, [str(model_path)], [empty_env], base, model, record["database_id"], sorted(files)


def runtime_env(container):
    return dict(item.split("=", 1) for item in container["Config"].get("Env", []) if "=" in item)


def tmpfs_options(options):
    result = {}
    for option in (options or "").split(","):
        if not option:
            continue
        key, _, value = option.partition("=")
        if key == "mode":
            result[key] = int(value, 8)
        elif key == "size":
            match = re.fullmatch(r"(\d+)([kmg]?)", value.lower())
            require(match is not None, "Unsupported tmpfs size notation.")
            result[key] = int(match.group(1)) * {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[match.group(2)]
        else:
            result[key] = value
    return result


def validate_tmpfs(configured, container):
    expected = {}
    entries = configured.get("tmpfs", [])
    if isinstance(entries, str):
        entries = [entries]
    for entry in entries:
        target, _, options = entry.partition(":")
        expected[target] = tmpfs_options(options)
    for volume in configured.get("volumes", []):
        if volume["type"] == "tmpfs":
            options = volume.get("tmpfs", {})
            expected[volume["target"]] = {key: value for key, value in options.items() if key in ("size", "mode")}
    host = container.get("HostConfig", {})
    actual = {target: tmpfs_options(options) for target, options in (host.get("Tmpfs") or {}).items()}
    for mount in host.get("Mounts", []) or []:
        if mount.get("Type") == "tmpfs":
            options = mount.get("TmpfsOptions", {})
            actual[mount["Target"]] = {key: options[original] for original, key in (("SizeBytes", "size"), ("Mode", "mode"))
                                       if options.get(original)}
    require(expected == actual, "Recorded stack differs from running tmpfs paths or permissions.")


def validate_existing(model, containers, selected, *, only=None):
    services = model.get("services", {})
    names = set(only) if only is not None else (
        set(selected) | {"postgres", "gateway", "internal-gateway"} | (set(PROTECTED) & set(containers)))
    for name in names:
        require(name in services and name in containers, "An expected existing service is missing.")
        container = containers[name]
        require(container.get("State", {}).get("Running"), "An expected service is stopped; resolve it before upgrade.")
        configured = services[name]
        actual_env = runtime_env(container)
        defaults = json.loads(run(["docker", "image", "inspect", "--format", "{{json .Config.Env}}", container["Image"]])) or []
        expected_env = dict(item.split("=", 1) for item in defaults if "=" in item)
        expected_env.update({k: str(v) for k, v in configured.get("environment", {}).items()})
        require(actual_env == expected_env,
                "Running service environment differs from the recorded Compose stack; refuse configuration drift.")
        mounts = {m["Destination"]: m for m in container.get("Mounts", [])}
        expected_mounts = set()
        for volume in configured.get("volumes", []):
            if volume["type"] == "tmpfs":
                continue
            target = volume["target"]
            expected_mounts.add(target)
            require(target in mounts, "Recorded configuration would change an existing mount.")
            actual = mounts[target]
            if volume["type"] == "bind":
                require(str(Path(volume["source"]).resolve()) == actual["Source"],
                        "Recorded configuration differs from a running bind mount.")
                require(Path(volume["source"]).exists(), "An existing bind source is unavailable.")
            elif volume["type"] == "volume":
                definition = model.get("volumes", {}).get(volume["source"], {})
                require(definition.get("name") == actual.get("Name"),
                        "Recorded configuration differs from the running persistent volume.")
            require(bool(volume.get("read_only", False)) == (not actual["RW"]),
                    "Recorded mount access differs from the running mount.")
        for secret in configured.get("secrets", []):
            definition = model.get("secrets", {}).get(secret["source"], {})
            target = secret.get("target", secret["source"])
            if not target.startswith("/"):
                target = "/run/secrets/" + target
            expected_mounts.add(target)
            require(definition.get("file") and Path(definition["file"]).is_file()
                    and mounts.get(target, {}).get("Source") == str(Path(definition["file"]).resolve()),
                    "An existing secret cannot be proven to match the running protected mount.")
        require({target for target, mount in mounts.items() if mount.get("Type") != "tmpfs"} == expected_mounts,
                "Recorded stack would drop or add a running mount; reconcile its overlays first.")
        validate_tmpfs(configured, container)
        expected_networks = {model.get("networks", {}).get(network, {}).get("name")
                             for network in configured.get("networks", {})}
        actual_networks = set(container.get("NetworkSettings", {}).get("Networks", {}))
        require(None not in expected_networks and actual_networks == expected_networks,
                "Recorded stack differs from the running service networks.")
        generated_aliases = {name, container.get("Name", "").lstrip("/"), container["Id"], container["Id"][:12]}
        for network, options in configured.get("networks", {}).items():
            actual_network = container["NetworkSettings"]["Networks"][model["networks"][network]["name"]]
            expected_aliases = set((options or {}).get("aliases", [])) - generated_aliases
            actual_aliases = set(actual_network.get("Aliases") or []) - generated_aliases
            require(expected_aliases == actual_aliases, "Recorded stack differs from the running service DNS aliases.")
        expected_ports = set()
        for port in configured.get("ports", []):
            require(port.get("published"), "Dynamic published ports are unsupported for a production upgrade.")
            expected_ports.add((str(port["target"]) + "/" + port.get("protocol", "tcp"),
                                port.get("host_ip") or "0.0.0.0", str(port["published"])))
        actual_ports = {(target, binding.get("HostIp") or "0.0.0.0", binding["HostPort"])
                        for target, bindings in (container.get("HostConfig", {}).get("PortBindings") or {}).items()
                        for binding in (bindings or [])}
        require(actual_ports == expected_ports, "Recorded stack differs from the running published ports.")
    if "postgres" not in names:
        return
    postgres = containers["postgres"]
    data = [m for m in postgres["Mounts"] if m["Destination"] == "/var/lib/postgresql/data"]
    require(len(data) == 1 and data[0]["Type"] == "volume", "Postgres must use its existing named data volume.")
    volume = services["postgres"]["volumes"]
    logical = next((v["source"] for v in volume if v["target"] == "/var/lib/postgresql/data"), None)
    require(model.get("volumes", {}).get(logical, {}).get("external") is True,
            "Database volume must remain explicitly external.")


def database_identity(container, expected):
    require(re.fullmatch(r"[0-9]{10,30}", expected or ""),
            "Supply the independently recorded PostgreSQL system identifier with --expected-database-id.")
    pgdata = runtime_env(container).get("PGDATA")
    require(pgdata and pgdata.startswith("/var/lib/postgresql/data/"), "Unexpected PostgreSQL data directory.")
    output = run(["docker", "exec", "--user", "postgres", "-e", "LC_ALL=C", container["Id"], "pg_controldata", pgdata])
    match = re.search(r"Database system identifier:\s*(\d+)", output)
    require(match and match.group(1) == expected, "PostgreSQL system identifier does not match the retained installation record.")


def plan_overlay(model, source, selected, commit, containers):
    services = {}
    production = source / "pasofi-backend/infra/production"
    update_names = list(selected) + [name + "-migrate" for name in selected if name in APPS]
    update_names += ["gateway", "internal-gateway"]
    hotspot = False
    for name in update_names:
        original = model["services"].get(name)
        require(original is not None, "The existing stack is missing a selected migration or service.")
        change = {}
        base = name.removesuffix("-migrate")
        if base in selected:
            change["image"] = "pasofi-local/" + base + ":" + commit
        elif name in ("gateway", "internal-gateway"):
            # Gateway configuration changes must not silently upgrade the Nginx image.
            change["image"] = containers[name]["Image"]
        volumes = []
        for volume in original.get("volumes", []):
            target = volume["target"]
            relative = CONFIG_BINDS.get(target)
            if target == "/etc/nginx/conf.d/default.conf" and name != "internal-gateway":
                relative = None
            if target == "/etc/nginx/templates/default.conf.template" and name == "gateway":
                old = Path(volume["source"]).name
                require(old in ("public.conf.template", "vercel.conf.template"),
                        "Unknown public gateway template; review it before rollout.")
                relative = "gateway/" + old
            if target == "/opt/pasofi/hotspot-web" and name == "gateway":
                require("web" in selected, "An active captive portal requires web in the release manifest.")
                replacement = source.parent / "hotspot-dist"
                hotspot = True
            elif relative:
                replacement = production / relative
                require(replacement.is_file(), "Pinned source is missing a required production configuration file.")
            else:
                continue
            require(volume["type"] == "bind" and volume.get("read_only") is True,
                    "A managed configuration bind is not read-only.")
            updated = copy.deepcopy(volume)
            updated["source"] = str(replacement)
            updated.setdefault("bind", {})["create_host_path"] = False
            volumes.append(updated)
        if volumes:
            change["volumes"] = volumes
        services[name] = change
    require(not (set(services) & set(PROTECTED)), "Protected service entered the upgrade plan.")
    return {"services": services}, hotspot


def verify_delta(before, after, overlay):
    expected = copy.deepcopy(before)
    for name, change in overlay["services"].items():
        service = expected["services"][name]
        if "image" in change:
            service["image"] = change["image"]
        replacements = {v["target"]: v for v in change.get("volumes", [])}
        service["volumes"] = [replacements.get(v["target"], v) for v in service.get("volumes", [])]
        if not service["volumes"]:
            del service["volumes"]
    require(expected == after,
            "Compose merge changed more than selected images and approved configuration binds; rollout refused.")


def protected_snapshot(containers):
    return {name: {**{key: containers[name].get(key) for key in ("Id", "Image", "HostConfig", "NetworkSettings")},
                   "Mounts": canonical_mounts(containers[name]),
                   "running": containers[name].get("State", {}).get("Running")}
            for name in PROTECTED if name in containers}


def write_private(path, data):
    Path(path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def write_compose(path, model):
    write_private(path, literal_compose(model))


@contextmanager
def apply_lock(directory, project):
    import fcntl
    # The original working directory is shared by every release of this project.
    lock_path = directory / (".pasofi-release-" + project + ".lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal("Another apply holds the project deployment lock; wait for its result.") from None
        yield
    finally:
        os.close(descriptor)


def build_release(source, selected, commit, hotspot, log):
    images = {}
    for name in selected:
        directory = source / ("pasofi-frontend/web" if name == "web" else
                              "pasofi-backend/services/" + name + "-service")
        require((directory / "package-lock.json").is_file(), "A selected service has no locked dependency file.")
        run(["docker", "run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
             "--user", str(os.getuid()) + ":" + str(os.getgid()), "-e", "npm_config_cache=/tmp/npm-cache",
             "--mount", "type=bind,src=" + str(directory) + ",dst=/work", "-w", "/work",
             NODE_IMAGE, "sh", "-c", "npm ci --no-audit --no-fund && npm run build"], log=log)
        run(["docker", "build", "--label", "org.opencontainers.image.revision=" + commit,
             "-t", "pasofi-local/" + name + ":" + commit, str(directory)], log=log)
        image_id = run(["docker", "image", "inspect", "--format", "{{.Id}}",
                        "pasofi-local/" + name + ":" + commit]).strip()
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", image_id), "A built image has no valid immutable ID.")
        images[name] = image_id
        if name == "web" and hotspot:
            run(["docker", "run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                 "--user", str(os.getuid()) + ":" + str(os.getgid()), "-e", "npm_config_cache=/tmp/npm-cache",
                 "-e", "VITE_PASOFI_HOTSPOT_PORTAL=1", "--mount", "type=bind,src=" + str(directory) + ",dst=/work",
                 "-w", "/work", NODE_IMAGE, "npm", "run", "build"], log=log)
            shutil.copytree(directory / "dist", source.parent / "hotspot-dist")
    return images


def prepare_automatic_backup(postgres, expected_database_id, source, release):
    """Automatic apply requires the packaged protected-backup qualification guard."""
    helper = Path(__file__).resolve().with_name("deployment-backup.py")
    require(helper.is_file(), "The automatic deployment backup guard is missing; deployment stopped before building or migrating.")
    for filename in ("deployment-backup.py", "deployment-restore.py"):
        uploaded = helper.with_name(filename)
        pinned = Path(source) / "pasofi-backend/local-tools/manual deployment" / filename
        try:
            matches = (uploaded.is_file() and not uploaded.is_symlink() and pinned.is_file() and not pinned.is_symlink()
                       and uploaded.stat().st_size <= 128 * 1024 and pinned.stat().st_size <= 128 * 1024
                       and uploaded.read_bytes() == pinned.read_bytes())
        except OSError:
            matches = False
        require(matches, "The automatic backup helpers differ from the pinned source; deployment stopped before loading them.")
    try:
        specification = importlib.util.spec_from_file_location("pasofi_deployment_backup", helper)
        require(specification is not None and specification.loader is not None,
                "The automatic deployment backup guard could not be loaded.")
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        backup_error = module.BackupError
        prepare = module.prepare_backup
    except Refusal:
        raise
    except Exception:
        raise Refusal("The automatic deployment backup guard could not be loaded.") from None
    try:
        evidence = prepare(postgres, expected_database_id, source, release)
    except backup_error as error:
        raise Refusal(str(error)) from None
    except Exception:
        raise Refusal("Automatic backup qualification did not complete; deployment stopped before building or migrating.") from None
    valid = (type(evidence) is dict and type(evidence.get("schema")) is int and evidence.get("schema") == 1
             and all(evidence.get(key) == value for key, value in {
                 "status": "passed", "encrypted_backup": "passed", "fresh_backup": "passed",
                 "isolated_restore": "passed", "cluster_identity": "matched",
                 "migration_ledgers": "matched_all_five", "cleanup": "passed",
                 "restore_scope": "new_disposable_volume_on_existing_host"}.items())
             and evidence.get("off_host_recovery_tested") is False
             and type(evidence.get("restore_image_id")) is str
             and re.fullmatch(r"sha256:[0-9a-f]{64}", evidence["restore_image_id"]) is not None
             and evidence.get("restore_image_id") == postgres.get("Image")
             and evidence.get("restored_backup_label") == evidence.get("backup_label")
             and type(evidence.get("backup_completed_at_unix")) is int and evidence["backup_completed_at_unix"] > 0
             and type(evidence.get("backup_label")) is str
             and re.fullmatch(r"[0-9]{8}-[0-9]{6}F(?:_[0-9]{8}-[0-9]{6}[DI])?", evidence["backup_label"]) is not None
             and type(evidence.get("completed_at_utc")) is str)
    try:
        valid = valid and datetime.fromisoformat(evidence["completed_at_utc"]).tzinfo == timezone.utc
    except ValueError:
        valid = False
    require(valid, "Automatic backup qualification returned invalid evidence; deployment stopped.")
    return evidence


def remote(args):
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", args.host or ""),
            "Use an existing SSH alias or user@hostname; put ports and identity files in SSH config.")
    require(not args.release_root, "--release-root is local-server-only.")
    uploads = [(Path(__file__).resolve(), "release-deploy.py"),
               (Path(args.manifest).resolve(), "release.json"),
               (Path(args.archive).resolve(), "source.tar.gz")]
    if getattr(args, "discover_existing", False) and args.apply:
        for filename in ("deployment-backup.py", "deployment-restore.py"):
            helper = Path(__file__).resolve().with_name(filename)
            require(helper.is_file() and not helper.is_symlink(), "An automatic deployment backup helper is missing; nothing was sent to the server.")
            uploads.append((helper, filename))
    # Never prompt, add host keys, forward agents, or reuse a control connection.
    remote_dir = run(["ssh", *SSH_OPTIONS, args.host, "umask 077; mktemp -d /tmp/pasofi-release.XXXXXXXX"]).strip()
    require(re.fullmatch(r"/tmp/pasofi-release\.[A-Za-z0-9]+", remote_dir), "Unexpected remote staging path.")
    try:
        for local, filename in uploads:
            run(["scp", *SSH_OPTIONS, str(local), args.host + ":" + remote_dir + "/" + filename])
        command = ["python3", "-I", "-B", "-S", remote_dir + "/release-deploy.py", "--manifest", remote_dir + "/release.json",
                   "--archive", remote_dir + "/source.tar.gz"]
        if getattr(args, "discover_existing", False):
            command += ["--discover-existing"]
        else:
            command += ["--expected-database-id", args.expected_database_id]
        if args.project:
            command += ["--project", args.project]
        for env_file in args.env_file:
            command += ["--env-file", env_file]
        if args.apply:
            command += ["--apply"]
        # The remote script prints only its safe progress messages, never Docker/Compose output.
        result = subprocess.run(["ssh", *SSH_OPTIONS, args.host, shlex.join(command)],
                                stdin=subprocess.DEVNULL, check=False)
        require(result.returncode == 0, "Remote deployment command did not complete successfully.")
    finally:
        run(["ssh", *SSH_OPTIONS, args.host, "rm -f " + shlex.join([remote_dir + "/" + filename for _, filename in uploads])
             + " && rmdir " + shlex.quote(remote_dir)])


def deploy(args):
    args = copy.copy(args)
    manifest = load_manifest(args.manifest, args.archive)
    require(getattr(args, "capture_baseline", None) or not getattr(args, "origin_env", []),
            "Supplemental origin environment selection belongs to baseline capture, not apply or other discovery modes.")
    service_baseline = bool(getattr(args, "baseline", None) or getattr(args, "capture_baseline", None))
    if service_baseline:
        require(not (getattr(args, "baseline", None) and getattr(args, "capture_baseline", None))
                and not args.host and not getattr(args, "discover_existing", False)
                and not args.env_file and args.expected_database_id is None,
                "Per-service baselines are direct-server operations and cannot mix manual or automatic discovery inputs.")
        require(not getattr(args, "capture_baseline", None) or not args.apply,
                "Baseline capture never applies a release.")
        require(getattr(args, "capture_baseline", None) or not getattr(args, "migration_origin", []),
                "Migration-origin selection belongs to baseline capture, not apply.")
    elif getattr(args, "discover_existing", False):
        require(not args.env_file and args.expected_database_id is None,
                "Automatic discovery cannot be combined with manually supplied environment files or database identity.")
    else:
        require(re.fullmatch(r"[0-9]{10,30}", args.expected_database_id or "") is not None,
                "Supply the retained --expected-database-id, or use --discover-existing for verified installation records.")
    if args.host:
        return remote(args)
    require(os.name == "posix", "Run via --host from Windows, or run on the existing Linux Docker host.")
    project, containers = inspect_project(args.project)
    if getattr(args, "capture_baseline", None):
        return capture_service_baseline(args, manifest, project, containers)
    if getattr(args, "baseline", None):
        directory, files, env_files, base, model, args.expected_database_id, input_files = load_service_baseline(
            args, manifest, project, containers)
    else:
        if getattr(args, "discover_existing", False):
            args.env_file, args.expected_database_id = discover_existing_inputs(containers)
        require(args.env_file, "Supply the existing protected Compose --env-file; do not create or guess one.")
        env_files = [Path(path).resolve() for path in args.env_file]
        require(all(path.is_file() for path in env_files), "An existing environment file is missing.")
        directory, files = discover_stack(containers)
        base = compose_command(project, directory, files, env_files)
        model = resolved_compose(base)
        input_files = [*files, *env_files]
    validate_existing(model, containers, manifest["services"])
    database_identity(containers["postgres"], args.expected_database_id)
    old_protected = protected_snapshot(containers)
    file_hashes = {str(path): hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in input_files}
    with tempfile.TemporaryDirectory(prefix="pasofi-preflight-") as temporary:
        source = extract_source(args.archive, temporary, manifest["commit"])
        overlay, hotspot = plan_overlay(model, source, manifest["services"], manifest["commit"], containers)
        overlay_path = Path(temporary) / "upgrade.compose.json"
        write_compose(overlay_path, overlay)
        planned = resolved_compose(base + ["-f", str(overlay_path)])
        verify_delta(model, planned, overlay)
    print("Preflight passed: release " + manifest["commit"] + ".", flush=True)
    print("Existing Compose project: " + project + ".", flush=True)
    print("Existing service provenance, ordered configuration, protected secrets and external database volume verified.", flush=True)
    print("Update: " + ", ".join(manifest["services"]) + "; gateways; owned migrations: "
          + ", ".join(manifest["migrations"]) + ("; existing captive portal assets." if hotspot else "."), flush=True)
    print("Runtime order: " + " -> ".join(", ".join(phase) for phase in rollout_phases(manifest["services"])) + ".", flush=True)
    print("Postgres and RADIUS containers are excluded; all current delivery and launch gates are retained.", flush=True)
    if not args.apply:
        print("No runtime changes made. Run the same command with --apply after reviewing this plan.")
        return
    lock_directories = {str(directory)}
    if getattr(args, "baseline", None):
        lock_directories.update(origin["working_directory"] for origin in args._baseline_record["origins"].values())
    with ExitStack() as locks:
        for lock_directory in sorted(lock_directories):
            locks.enter_context(apply_lock(Path(lock_directory), project))
        # Recheck the captured snapshot after acquiring all historical locks.
        if getattr(args, "baseline", None):
            _, current = inspect_project(project)
            recheck_discovered_inputs(args, current)
        apply_release(args, manifest, project, containers, directory, files, env_files, base,
                      model, old_protected, file_hashes)


def apply_release(args, manifest, project, containers, directory, files, env_files, base,
                  model, old_protected, file_hashes):
    root = Path(args.release_root or (Path.home() / ".local/share/pasofi-releases"))
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(root.stat().st_mode & 0o077 == 0, "Release record root must be private (mode 0700).")
    release = Path(tempfile.mkdtemp(prefix=manifest["commit"] + "-", dir=root))
    source = extract_source(args.archive, release, manifest["commit"])
    overlay, hotspot = plan_overlay(model, source, manifest["services"], manifest["commit"], containers)
    overlay_path = release / "upgrade.compose.json"
    write_compose(overlay_path, overlay)
    upgrade = base + ["-f", str(overlay_path)]
    targets = [*manifest["services"], "internal-gateway", "gateway"]
    phases = rollout_phases(manifest["services"])
    rollback = {"services": {name: {"image": containers[name]["Image"],
                                   "volumes": model["services"][name].get("volumes", [])}
                             for name in targets}}
    write_compose(release / "rollback.compose.json", rollback)
    write_private(release / "before.compose.json", model)
    write_private(release / "release.json", manifest)
    write_private(release / "record.json", {"project": project, "compose_files": files,
                  "env_files": [str(path) for path in env_files], "file_hashes": file_hashes,
                  "protected": old_protected, "targets": targets, "rollout_phases": phases,
                  **({"service_baseline": args._baseline_record} if getattr(args, "baseline", None) else {}),
                  "rollback_command": base + ["-f", str(release / "rollback.compose.json"), "up", "-d",
                                               "--no-deps", "--no-build", "--pull", "never", *targets],
                  "database_rollback": "None: additive migrations are retained. Never restore an older database over new sales."})
    log = release / "operations.log"
    print("Private rollback record: " + str(release / "record.json"), flush=True)
    if getattr(args, "discover_existing", False) or getattr(args, "baseline", None):
        prepare_automatic_backup(containers["postgres"], args.expected_database_id, source, release)
    print("Building pinned application images and existing captive assets; private build log is in the record directory.", flush=True)
    built_images = build_release(source, manifest["services"], manifest["commit"], hotspot, log)
    expected_images = {**built_images, **{name: containers[name]["Image"] for name in ("gateway", "internal-gateway")}}
    require(set(expected_images) == set(targets), "Pinned builds must cover exactly the selected runtime targets.")
    # Recheck immediately before the first database/runtime mutation.
    require(all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
                for path, digest in file_hashes.items()), "Compose/environment files changed during build; stopped before migration.")
    _, current = inspect_project(project)
    require({n: c["Id"] for n, c in current.items()} == {n: c["Id"] for n, c in containers.items()},
            "The running installation changed during build; stopped before migration.")
    recheck_discovered_inputs(args, current)
    database_identity(current["postgres"], args.expected_database_id)
    planned = resolved_compose(upgrade)
    verify_delta(model, planned, overlay)
    for service in manifest["migrations"]:
        print("Applying owned migrations: " + service + ".", flush=True)
        run(upgrade + ["run", "--rm", "--no-deps", "--pull", "never", service + "-migrate"], log=log)
    completed = []
    for phase in phases:
        print("Updating runtime phase: " + ", ".join(phase) + ".", flush=True)
        run(upgrade + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", *phase], log=log)
        completed.extend(phase)
        _, after = inspect_project(project)
        require(protected_snapshot(after) == old_protected, "Protected container state changed; investigate using the private record.")
        verify_rollout_phase(after, completed, phase, expected_images, log)
        database_identity(after["postgres"], args.expected_database_id)
    write_private(release / "completed.json", {"commit": manifest["commit"], "completed_at_unix": int(time.time()),
                  "images": {name: after[name]["Image"] for name in targets}})
    print("Rollout completed and container health checks passed. Complete the physical/payment acceptance checks in the operator guide.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--expected-database-id", help="Independently retained production PostgreSQL system identifier")
    parser.add_argument("--discover-existing", action="store_true",
                        help="Read complete ordered environment-file labels and the retained installation database record on the server")
    parser.add_argument("--capture-baseline", help="Verify mixed service origins and write a new private baseline; no runtime changes")
    parser.add_argument("--baseline", help="Use a previously captured per-service baseline on the existing Docker host")
    parser.add_argument("--migration-origin", action="append", default=[],
                        help="Capture only: owned-service=observed-service whose original model contains that migration")
    parser.add_argument("--origin-env", action="append", default=[],
                        help="Capture only: append one private supplemental environment file for a named observed service")
    parser.add_argument("--env-file", action="append", default=[], help="Existing absolute path on the Docker host; repeat in original order")
    parser.add_argument("--host", help="Existing OpenSSH alias or user@hostname")
    parser.add_argument("--project", help="Existing Docker Compose project, if discovery is ambiguous")
    parser.add_argument("--release-root", help="Existing private record root on the Docker host")
    parser.add_argument("--apply", action="store_true", help="Build, migrate and update after the same preflight")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        deploy(args)
    except (Refusal, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        # Avoid displaying input paths, resolved configuration, command output or credentials.
        message = str(error) if isinstance(error, Refusal) else "Invalid input or unavailable local resource; rollout stopped."
        print("STOPPED: " + message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
