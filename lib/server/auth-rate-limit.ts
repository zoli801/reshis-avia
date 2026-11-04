import { PublicError, sha256, unixNow } from "./security.ts";

/** Atomic durable limits; neither IP addresses nor usernames are stored raw. */
export async function consumeAuthRateLimit(request:Request,db:D1Database,scope:string,key?:string,options:{limit?:number;seconds?:number}={}):Promise<void> {
  const limit=options.limit??60,seconds=options.seconds??900,current=unixNow();
  const identity=key??request.headers.get("CF-Connecting-IP")??"unknown-network";
  const bucket=await sha256(`${scope}:${identity}`);
  const row=await db.prepare("INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING attempts")
    .bind(bucket,current+seconds,current,current).first<{attempts:number}>();
  if(!row||row.attempts>limit)throw new PublicError(429,"Слишком много попыток. Повторите вход позже.");
  // Bounded cleanup avoids keeping abandoned login identifiers indefinitely.
  await db.prepare("DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE expires_at<? LIMIT 50)").bind(current).run();
}
