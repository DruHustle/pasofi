# Oracle capacity and a path to scaling

This is an inventory and planning record, not an instruction to provision or
change infrastructure. Values were checked on 3 November 2026 and must be
rechecked before purchasing, resizing, deleting or migrating resources.

## Current deployment

PamoFi production runs on the shared **Onesa UG Backend** alongside other Onesa
services. Its frontend remains on Vercel. Oracle currently has these instances:

| Instance | Shape | Allocated compute | Boot volume | Network |
| --- | --- | --- | --- | --- |
| Onesa UG Backend | ARM A1 Flex | 1 OCPU, 6 GB RAM | 100 GB | `onesa-portal-worker-vcn` |
| Software Engineering Backend | ARM A1 Flex | 1 OCPU, 6 GB RAM | 50 GB | `software-engineering-backend-vcn` |
| PamoFi Backend | AMD E2.1.Micro | Micro, 1 GB RAM | 50 GB | `software-engineering-backend-vcn` |

The separate PamoFi Backend instance is not the current PamoFi production
host. OCI allows more than one instance per VCN; dedicated VCNs are an isolation
choice, not a requirement. The owner asked to keep PamoFi production on the
Onesa VM and not to rename the VCN. Its hostname, VCN and subnet names may
still reference the older portal-worker purpose; changing those names requires
separate impact review because other Onesa services use the same host.

## Free capacity and billing

Oracle's free-tenancy documentation lists up to two AMD E2.1.Micro instances,
plus a total of 1,500 ARM A1 OCPU-hours and 9,000 GB-hours per month (roughly
2 OCPUs and 12 GB continuously), and 200 GB of combined boot and block volume
storage. Oracle's price list separately states a larger A1 monthly free
allowance for paid tenancies: 3,000 OCPU-hours and 18,000 GB-hours. Confirm the
account's subscription and applicable offer before assuming which allowance
applies. Oracle can also report temporary lack of shape capacity.

The two existing ARM instances together allocate 2 OCPUs and 12 GB. The three
identified boot volumes total 200 GB, and the regional Always Free storage quota
reported zero remaining. Oracle reported one additional AMD Micro slot in the
PamoFi VM's availability domain, but another VM also needs a boot volume and
physical capacity. A general service quota being available is not evidence
that additional usage would be free. Do not terminate an instance or delete a
volume merely to reclaim quota without a separately reviewed recovery plan.

## Staged scaling approach

1. Keep the working production Compose deployment and independent backups
   while measuring CPU, memory, disk, network and recovery time under a
   realistic pilot. Set capacity thresholds and test restores before migration.
2. Make releases portable: build and qualify immutable ARM and AMD images,
   retain migration-compatible rollback images, and define the network and
   deployment configuration as reviewed infrastructure-as-code.
3. Use a separate test environment to evaluate lightweight Kubernetes such as
   K3s. A single-node cluster helps learn deployment mechanics but does not
   provide high availability; do not install it over the current production
   stack as a shortcut.
4. When justified by load and budget, plan a multi-node rollout with separate
   environments, least-privilege identities, ingress, secrets, monitoring and
   network policy. Keep PostgreSQL persistence, backups, recovery and schema
   migration ownership explicit rather than assuming that Kubernetes supplies
   them automatically.
5. Consider Oracle Kubernetes Engine (OKE) alongside self-managed Kubernetes.
   Oracle lists the OKE Basic Cluster service as free, but worker compute,
   storage, load balancers, networking and any usage beyond free allowances can
   incur charges. Check the estimate, quotas and actual eligible resources
   before enabling them. A Basic Cluster also has a service-level objective,
   not the financially backed SLA of an Enhanced Cluster.

References: [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
[Oracle price list](https://www.oracle.com/cloud/price-list/),
[Oracle VNICs](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingVNICs.htm),
and [OKE cluster types](https://docs.oracle.com/en-us/iaas/Content/ContEng/Concepts/contengclustersnodes.htm).
