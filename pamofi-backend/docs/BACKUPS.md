# Backups

No production backup, archiving, restore scheduler or recovery drill is implemented. A named local Docker volume is persistence, not a backup. Before production, implement and test encrypted off-server full-cluster backups and continuous WAL archiving, retention-aware expiration, isolated restore, reconciliation and old-server fencing. The proposed B2 and pgBackRest setup has not been configured or qualified.
