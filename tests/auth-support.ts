import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

/** Actual SQLite with a small asynchronous D1-shaped adapter. No network. */
export function testDatabase() {
  const sqlite=new DatabaseSync(":memory:");
  // Use every production migration; auth schema must match the hosted database.
  const directory=new URL("../drizzle/",import.meta.url);
  for(const filename of readdirSync(directory).filter(name=>name.endsWith(".sql")).sort())sqlite.exec(readFileSync(new URL(filename,directory),"utf8"));
  const prepared=(sql:string,values:unknown[]=[])=>({
    bind(...next:unknown[]){return prepared(sql,next);},
    async first<T>(){return (sqlite.prepare(sql).get(...values as (string|number|null)[])??null) as T|null;},
    async all<T>(){return {results:sqlite.prepare(sql).all(...values as (string|number|null)[]) as T[],success:true};},
    async run(){const result=sqlite.prepare(sql).run(...values as (string|number|null)[]);return {meta:{changes:Number(result.changes)},success:true};},
  });
  const db={prepare:prepared,async batch(statements:{run:()=>Promise<unknown>}[]){sqlite.exec("BEGIN");try{const results=[];for(const item of statements)results.push(await item.run());sqlite.exec("COMMIT");return results;}catch(error){sqlite.exec("ROLLBACK");throw error;}}} as unknown as D1Database;
  return {db,sqlite,close:()=>sqlite.close()};
}
