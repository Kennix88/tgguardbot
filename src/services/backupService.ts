import { spawn } from "child_process";
import { gzip } from "zlib";
import { config } from "../config";
import { logger } from "../logger";

/**
 * On-demand PostgreSQL backup (used by the super-admin `/backup` command).
 *
 * Runs `pg_dump` against `DATABASE_URL`, pipes the SQL through gzip, and
 * resolves with the compressed bytes + a timestamped filename. The result is
 * uploaded to Telegram via `ctx.api.sendDocument`.
 *
 * NOTE: `pg_dump` must be present in the runtime image (see Dockerfile). The
 * version is pinned to match the server (PostgreSQL 16) to avoid
 * version-mismatch warnings.
 */
export interface BackupArchive {
    filename: string;
    /** gzip-compressed SQL dump */
    data: Buffer;
}

export async function createBackupArchive(): Promise<BackupArchive> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `backup_${timestamp}.sql.gz`;

    const sql = await dumpDatabase();
    const data = await gzipAsync(sql);

    logger.info(
        { filename, bytes: data.length },
        "backup archive created",
    );

    return { filename, data };
}

/** Spawn `pg_dump` reading credentials from `DATABASE_URL` (libpq URI). */
function dumpDatabase(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const dump = spawn("pg_dump", [
            config.DATABASE_URL,
            "--no-owner",
            "--no-privileges",
        ]);

        const chunks: Buffer[] = [];
        let stderr = "";

        dump.stdout.on("data", (c: Buffer) => chunks.push(c));
        dump.stderr.on("data", (c: Buffer) => {
            stderr += c.toString();
        });

        dump.on("error", (err) => {
            // Most likely `pg_dump` binary missing from the image.
            reject(
                new Error(
                    `failed to spawn pg_dump (is it installed in the image?): ${err.message}`,
                ),
            );
        });

        dump.on("close", (code) => {
            if (code !== 0) {
                reject(
                    new Error(
                        `pg_dump exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
                    ),
                );
                return;
            }
            resolve(Buffer.concat(chunks));
        });
    });
}

function gzipAsync(input: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        gzip(input, { level: 9 }, (err, out) => {
            if (err) reject(err);
            else resolve(out);
        });
    });
}
