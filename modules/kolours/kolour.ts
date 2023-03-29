import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";
import { IPFSHTTPClient } from "ipfs-http-client/dist/src/types";
import sharp from "sharp";

import { Kolour, MintedKolourEntry } from "./types/Kolours";

import { Sql } from "@/modules/next-backend/db";
import locking from "@/modules/next-backend/locking";

const IMAGE_OPTIONS: Omit<sharp.Create, "background"> = {
  width: 128,
  height: 128,
  channels: 3,
};

export async function areKoloursAvailable(
  sql: Sql,
  kolours: Kolour[]
): Promise<boolean> {
  if (!kolours.length) return true;
  const res = await sql`
    SELECT
    FROM kolours.kolour_book
    WHERE
      kolour IN ${sql(kolours)}
      AND status <> 'expired';
  `;
  return !res.count;
}

export async function getUnavailableKolours(
  sql: Sql,
  kolours: Kolour[]
): Promise<Set<Kolour>> {
  if (!kolours.length) return new Set();
  const rows = await sql<{ kolour: Kolour }[]>`
    SELECT
      kolour
    FROM
      kolours.kolour_book
    WHERE
      kolour IN ${sql(kolours)}
      AND status <> 'expired';
  `;
  return new Set(rows.map((r) => r.kolour));
}

export async function getAllMintedKolours(
  sql: Sql
): Promise<MintedKolourEntry[]> {
  const rows = await sql<MintedKolourEntry[]>`
    WITH kolour_earning AS (
      SELECT
        gp.kolour,
        sum(coalesce(gb.fee / 100, gl.listed_fee / 200))::bigint AS expected_earning
      FROM
        kolours.genesis_kreation_list gl
        LEFT JOIN kolours.genesis_kreation_book gb
          ON gb.kreation = gl.kreation
            AND gb.status <> 'expired'
        INNER JOIN kolours.genesis_kreation_palette gp
          ON gp.kreation_id = gl.id
      GROUP BY
        gp.kolour
    )
    SELECT
      kb.kolour,
      kb.user_address,
      kb.fee,
      ke.expected_earning
    FROM
      kolours.kolour_book kb
      LEFT JOIN kolour_earning ke
        ON ke.kolour = kb.kolour
    WHERE
      kb.status <> 'expired'
    ORDER BY
      kb.id ASC
  `;
  return rows.slice();
}

export async function generateKolourImageCid(
  redis: Redis,
  ipfs: IPFSHTTPClient,
  kolour: Kolour
) {
  const cidKey = KOLOUR_IMAGE_CID_PREFIX + kolour;
  let cached = await redis.get(cidKey);
  if (cached) return cached;

  const lockKey = KOLOUR_IMAGE_LOCK_PREFIX + kolour;
  const lock = await locking.acquire(lockKey, randomUUID(), { ttl: 5 }, 200);
  try {
    // Fetch again, just in case the image was already processed, better use WATCH
    cached = await redis.get(cidKey);
    if (cached) return cached;
    const image = await createKolourImage(kolour);
    const { cid } = await ipfs.add(image, { pin: true });
    const cidStr = cid.toString();
    await redis.set(cidKey, cidStr, "EX", 86400); // 1 day
    return cidStr;
  } finally {
    lock.release();
  }
}

export async function createKolourImage(kolour: Kolour): Promise<Buffer> {
  return sharp({
    create: { ...IMAGE_OPTIONS, background: `#${kolour}` },
  })
    .png({ colors: 2 })
    .toBuffer();
}

export const KOLOUR_IMAGE_CID_PREFIX = "ko:kolour:img:";
export const KOLOUR_IMAGE_LOCK_PREFIX = "ko:kolour:img.lock:";
