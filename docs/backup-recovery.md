# Mission Control encrypted tenant backup and restore verification

## Architecture

The backup pipeline is tenant authorization → validated portable tenant export → package → authenticated encryption → SHA-256 → provider upload → remote inventory verification → independent restore verification → audit/status. The portable export is the recovery payload and contains the JSON/JSONL, Markdown durable-memory, manifest, and checksum files described by the export validator.

The provider contract is implemented in `src/lib/backup-provider.ts`. It exposes upload, download, list, delete, verification, and capability flags so off-site adapters do not become part of the backup format. The reference adapter is `local-filesystem`; its root is outside the source tree and each object is mode `0600` beneath a tenant-specific mode `0700` directory.

## Encryption and keys

The current container format is `mc-backup-aes256gcm-1`: a small JSON header, a random 96-bit nonce, AES-256-GCM ciphertext, and the GCM authentication tag. The header is authenticated as additional authenticated data. The encrypted artifact, not the plaintext export, is the provider object. The SHA-256 recorded in the database is the checksum of the complete encrypted artifact.

The policy stores only `encryption_profile_ref` (currently `local-default`). The 32-byte recovery key is never stored in SQLite, Git, the export, or logs. The service reads it from `MC_BACKUP_KEY_<PROFILE>`, `MC_BACKUP_KEY` for `local-default`, or `MC_BACKUP_KEY_FILE`. The production key file is outside the repository, mode `0600`, and must also be held in an offline operator-controlled recovery location. Rotation creates a new profile/key reference; old records retain their original profile reference and remain decryptable with the old offline key.

## Independent disaster recovery

The web application is not required for verification. Given an encrypted `.mcbackup` object and the corresponding recovery key file, an operator runs:

```sh
node scripts/verify-tenant-backup.mjs \
  --artifact /recovered/object.mcbackup \
  --key-file /offline/mission-control-local-default.key
```

The utility verifies the container authentication, package and nested export archive safety, manifest identity/schema, every checksum, required files, durable-memory structure, and secret-like content. It extracts only to a new isolated temporary directory unless `--destination` is explicitly supplied. It never writes live Mission Control data. Any failure exits non-zero.

## Policy, retention, and scheduling

Each tenant has a policy and tenant-scoped backup records. The policy contains provider/key references, export/backup/integrity/restore schedules, retention count/period, status, failure reason, and last-success timestamps. The local provider retention path never removes the only verified recovery point. Automatic tenant backup scheduling is a bounded, disabled-by-default scheduler task (`general.tenant_backup`); it processes at most 20 enabled non-manual policies per invocation and records failures as notifications and audit events. No arbitrary shell command is scheduled.

## Current operational evidence

The first provider is intentionally local and deterministic. No usable off-site target was found on the VPS: `rclone` is installed but has no configured remotes, and no safe IDrive/WebDAV/S3/SFTP credentials were available. Therefore local backup/restore acceptance is separate from off-site disaster-recovery acceptance. Configure a real provider credential/reference only after security review; do not put credentials in tenant policy rows.
