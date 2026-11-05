#!/usr/bin/env python3
"""Pinned PasoFi upgrade of an existing Compose installation; preflight by default."""
import argparse
import copy
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

APPS = ("identity", "prepaid-access", "network", "notification", "assistant")
UPDATABLE = (*APPS, "web")
PROTECTED = ("postgres", "radius", "radius-api")
LABEL = "com.docker.compose."
NODE_IMAGE = "node:24.22.1-alpine"
SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]
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
    result = subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE,
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
    digest = hashlib.sha256()
    with open(archive, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    require(digest.hexdigest() == data["archive_sha256"], "Release archive hash mismatch.")
    return data


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
    containers = json.loads(run(["docker", "inspect", *ids]))
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


def compose_command(project, directory, files, env_files):
    result = ["docker", "compose", "--project-name", project,
              "--project-directory", str(directory), "--profile", "*"]
    for path in env_files:
        result.extend(["--env-file", str(path)])
    for path in files:
        result.extend(["-f", str(path)])
    return result


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


def validate_existing(model, containers, selected):
    services = model.get("services", {})
    for name in set(selected) | {"postgres", "gateway", "internal-gateway"} | (set(PROTECTED) & set(containers)):
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
    return {name: {**{key: containers[name].get(key) for key in ("Id", "Image", "Mounts", "HostConfig")},
                   "running": containers[name].get("State", {}).get("Running")}
            for name in PROTECTED if name in containers}


def write_private(path, data):
    Path(path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


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


def remote(args):
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", args.host or ""),
            "Use an existing SSH alias or user@hostname; put ports and identity files in SSH config.")
    require(not args.release_root, "--release-root is local-server-only.")
    # OpenSSH retains normal host-key verification. No credentials or private host values are logged.
    remote_dir = run(["ssh", *SSH_OPTIONS, args.host, "umask 077; mktemp -d /tmp/pasofi-release.XXXXXXXX"]).strip()
    require(re.fullmatch(r"/tmp/pasofi-release\.[A-Za-z0-9]+", remote_dir), "Unexpected remote staging path.")
    try:
        for local, filename in ((Path(__file__).resolve(), "release-deploy.py"),
                                (Path(args.manifest).resolve(), "release.json"),
                                (Path(args.archive).resolve(), "source.tar.gz")):
            run(["scp", *SSH_OPTIONS, str(local), args.host + ":" + remote_dir + "/" + filename])
        command = ["python3", remote_dir + "/release-deploy.py", "--manifest", remote_dir + "/release.json",
                   "--archive", remote_dir + "/source.tar.gz", "--expected-database-id", args.expected_database_id]
        if args.project:
            command += ["--project", args.project]
        for env_file in args.env_file:
            command += ["--env-file", env_file]
        if args.apply:
            command += ["--apply"]
        # The remote script prints only its safe progress messages, never Docker/Compose output.
        result = subprocess.run(["ssh", *SSH_OPTIONS, args.host, shlex.join(command)], check=False)
        require(result.returncode == 0, "Remote deployment command did not complete successfully.")
    finally:
        run(["ssh", *SSH_OPTIONS, args.host, "rm -f " + shlex.quote(remote_dir + "/release-deploy.py") + " "
             + shlex.quote(remote_dir + "/release.json") + " " + shlex.quote(remote_dir + "/source.tar.gz")
             + " && rmdir " + shlex.quote(remote_dir)])


def deploy(args):
    manifest = load_manifest(args.manifest, args.archive)
    if args.host:
        return remote(args)
    require(os.name == "posix", "Run via --host from Windows, or run on the existing Linux Docker host.")
    require(args.env_file, "Supply the existing protected Compose --env-file; do not create or guess one.")
    env_files = [Path(path).resolve() for path in args.env_file]
    require(all(path.is_file() for path in env_files), "An existing environment file is missing.")
    project, containers = inspect_project(args.project)
    directory, files = discover_stack(containers)
    base = compose_command(project, directory, files, env_files)
    model = json.loads(run(base + ["config", "--format", "json"]))
    validate_existing(model, containers, manifest["services"])
    database_identity(containers["postgres"], args.expected_database_id)
    old_protected = protected_snapshot(containers)
    file_hashes = {str(path): hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in [*files, *env_files]}
    with tempfile.TemporaryDirectory(prefix="pasofi-preflight-") as temporary:
        source = extract_source(args.archive, temporary, manifest["commit"])
        overlay, hotspot = plan_overlay(model, source, manifest["services"], manifest["commit"], containers)
        overlay_path = Path(temporary) / "upgrade.compose.json"
        write_private(overlay_path, overlay)
        planned = json.loads(run(base + ["-f", str(overlay_path), "config", "--format", "json"]))
        verify_delta(model, planned, overlay)
    print("Preflight passed: release " + manifest["commit"] + ".", flush=True)
    print("Existing Compose project: " + project + ".", flush=True)
    print("Existing ordered Compose overlays, protected secrets and external database volume verified.", flush=True)
    print("Update: " + ", ".join(manifest["services"]) + "; gateways; owned migrations: "
          + ", ".join(manifest["migrations"]) + ("; existing captive portal assets." if hotspot else "."), flush=True)
    print("Postgres and RADIUS containers are excluded; all current delivery and launch gates are retained.", flush=True)
    if not args.apply:
        print("No runtime changes made. Run the same command with --apply after reviewing this plan.")
        return
    with apply_lock(directory, project):
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
    write_private(overlay_path, overlay)
    upgrade = base + ["-f", str(overlay_path)]
    targets = [*manifest["services"], "internal-gateway", "gateway"]
    rollback = {"services": {name: {"image": containers[name]["Image"],
                                   "volumes": model["services"][name].get("volumes", [])}
                             for name in targets}}
    write_private(release / "rollback.compose.json", rollback)
    write_private(release / "before.compose.json", model)
    write_private(release / "release.json", manifest)
    write_private(release / "record.json", {"project": project, "compose_files": files,
                  "env_files": [str(path) for path in env_files], "file_hashes": file_hashes,
                  "protected": old_protected, "targets": targets,
                  "rollback_command": base + ["-f", str(release / "rollback.compose.json"), "up", "-d",
                                               "--no-deps", "--no-build", "--pull", "never", *targets],
                  "database_rollback": "None: additive migrations are retained. Never restore an older database over new sales."})
    log = release / "operations.log"
    print("Private rollback record: " + str(release / "record.json"), flush=True)
    print("Building pinned application images and existing captive assets; private build log is in the record directory.", flush=True)
    built_images = build_release(source, manifest["services"], manifest["commit"], hotspot, log)
    # Recheck immediately before the first database/runtime mutation.
    require(all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
                for path, digest in file_hashes.items()), "Compose/environment files changed during build; stopped before migration.")
    _, current = inspect_project(project)
    require({n: c["Id"] for n, c in current.items()} == {n: c["Id"] for n, c in containers.items()},
            "The running installation changed during build; stopped before migration.")
    database_identity(current["postgres"], args.expected_database_id)
    planned = json.loads(run(upgrade + ["config", "--format", "json"]))
    verify_delta(model, planned, overlay)
    for service in manifest["migrations"]:
        print("Applying owned migrations: " + service + ".", flush=True)
        run(upgrade + ["run", "--rm", "--no-deps", "--pull", "never", service + "-migrate"], log=log)
    print("Updating selected application containers and gateways.", flush=True)
    run(upgrade + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", *targets], log=log)
    _, after = inspect_project(project)
    require(protected_snapshot(after) == old_protected, "Protected container state changed; investigate using the private record.")
    expected_images = {**built_images, **{name: containers[name]["Image"] for name in ("gateway", "internal-gateway")}}
    require(all(after.get(name, {}).get("Image") == image_id for name, image_id in expected_images.items()),
            "A selected runtime image differs from the pinned build; no successful completion was recorded.")
    database_identity(after["postgres"], args.expected_database_id)
    write_private(release / "completed.json", {"commit": manifest["commit"], "completed_at_unix": int(time.time()),
                  "images": {name: after[name]["Image"] for name in targets}})
    print("Rollout completed and container health checks passed. Complete the physical/payment acceptance checks in the operator guide.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--expected-database-id", required=True)
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
