# Mission Control encrypted tenant backup and restore verification

## Architecture

The backup pipeline is tenant authorization → validated portable tenant export → package → authenticated encryption → SHA-256 → provider upload → remote inventory verification → independent restore verification → audit/status. The portable export is the recovery payload and contains the JSON/JSONL, Markdown durable-memory, manifest, and checksum files described by the export validator.

The provider contract is implemented in `src/lib/backup-provider.ts`. It exposes upload, download, list, delete, verification, and capability flags so transport adapters do not become part of the backup format. `local-filesystem` is the deterministic local adapter. `rclone:<profile-id>` is bounded: Mission Control constructs `copyto`, `lsjson`, `size`, and `deletefile` argument arrays and never accepts raw rclone flags, commands, remote paths, or configuration from a client.

Rclone profiles are references only. The database stores tenant, profile id, provider type, approved remote name, base prefix, role, capability state, and verification state; it never stores rclone credentials. A profile is usable only when its remote is listed in `MC_RCLONE_ALLOWED_REMOTES`, with `MC_RCLONE_PROFILE_<id>_REMOTE`, `MC_RCLONE_PROFILE_<id>_PREFIX`, and optionally `MC_RCLONE_CONFIG` supplied by the local operator. Generated objects are `<remote>:<base-prefix>/<tenant-stable-key>/<backup-id>.mcbackup`; traversal, control characters, leading slashes, colon injection, and option-like components are rejected.

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

Independent recovery is: obtain the key from offline escrow, obtain rclone credentials/configuration independently, retrieve the object, verify its SHA-256, run the verifier, recover validated portable tenant data, and rebuild Mission Control if necessary. No service, database, or production data directory is required.

## Policy, retention, and scheduling

Each tenant has a policy and tenant-scoped backup records. Records expose separate upload, remote-verification, restore-verification, retention, replication, and failure state; states include `LOCAL_ONLY`, `OFFSITE_PENDING`, `UPLOADED_UNVERIFIED`, `OFFSITE_VERIFIED`, `RESTORE_VERIFIED`, `PARTIAL_REPLICATION`, `STALE`, and `FAILED`. Remote verification checks inventory and size, then performs a bounded download and SHA-256 comparison. Restore verification uses an isolated temporary directory and validates encryption, metadata identity, archive safety, manifest, payload checksums, schema, durable memory, and secret exclusions without touching production data.

Automatic tenant backup scheduling is bounded and disabled by default (`general.tenant_backup`). Remote restore testing is a separate bounded, disabled-by-default task (`general.remote_restore_test`), tests at most one deterministic recovery point per tenant per day, and prefers points not recently tested. Retention fails closed when remote inventory is uncertain and never removes the only verified recovery point, a selected test point, or a point before replacement verification. Primary and optional secondary profile references are represented independently for future `PARTIAL_REPLICATION`.

## Current operational evidence

The first provider is intentionally local and deterministic. Inspection found `rclone v1.60.1-DEV`, no config file, and no configured remote names: `OFFSITE_CONFIGURATION_REQUIRED`. Configure a real provider locally after security review; never put credentials in tenant policy rows. For Backblaze B2, use the interactive local procedure: `rclone --config "$MC_RCLONE_CONFIG" config`, then `rclone --config "$MC_RCLONE_CONFIG" listremotes`. Set `MC_RCLONE_ALLOWED_REMOTES` to the exact remote name and set `MC_RCLONE_PROFILE_primary_REMOTE` plus `MC_RCLONE_PROFILE_primary_PREFIX` in the Mission Control service environment. Select `rclone:primary` in the tenant policy and restart the service. Acceptance requires upload → remote verify → isolated download → independent restore verification.
