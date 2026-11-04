import { env } from "cloudflare:workers";
import { handleApi } from "@/lib/server/services";
import type { AppEnv } from "@/lib/server/db";

type Context={params:Promise<{path:string[]}>|{path:string[]}};
async function handle(request:Request,context:Context){const {path}=await context.params;return handleApi(request,path.join('/'),env as unknown as AppEnv);}
export const GET=handle;
export const POST=handle;
export const PUT=handle;
export const PATCH=handle;
export const DELETE=handle;
