"use strict";
const fs = require("node:fs");
const path = require("node:path");
const DB = require("../db");
function validate() {
  for (const name of ["DATABASE_URL","APP_ORIGIN","ADMIN_PASSWORD","RAIS_PASSWORD"]) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  if (process.env.WEB_CONCURRENCY && process.env.WEB_CONCURRENCY !== "1") throw new Error("WEB_CONCURRENCY must be 1: storage uses one process");
  for (const name of ["ADMIN_PASSWORD","RAIS_PASSWORD"]) if (process.env[name].length < 16) throw new Error(`${name} must have at least 16 characters`);
  if(process.env.ANTHROPIC_API_KEY&&!process.env.ANTHROPIC_MODEL)throw new Error("ANTHROPIC_MODEL is required when ANTHROPIC_API_KEY is configured");
  const origin = new URL(process.env.APP_ORIGIN);
  if (origin.origin !== process.env.APP_ORIGIN || (process.env.NODE_ENV === "production" && origin.protocol !== "https:")) throw new Error("APP_ORIGIN must be an exact HTTPS origin in production");
  for (const name of ["PORT","STARTUP_TIMEOUT","DOC_TTL_DAYS"]) {
    if (process.env[name] && (!/^\d+$/.test(process.env[name]) || Number(process.env[name]) < 1)) throw new Error(`${name} must be a positive integer`);
  }
  for (const name of ["data","uploads"]) {
    const dir = path.join(__dirname,"..",name); fs.mkdirSync(dir,{recursive:true}); fs.accessSync(dir,fs.constants.W_OK);
  }
}
// Existing domain handlers are synchronous around writes. Buffer both JSON and
// downloads until every queued write has reached PostgreSQL; never send early 2xx.
async function durableResponse(req,res,handler) {
  let status=200, headers={"Cache-Control":"no-store"}, body=Buffer.alloc(0), ended=false;
  const buffered={
    setHeader(name,value){headers[name]=value;}, getHeader(name){return headers[name];},
    writeHead(code,values={}){status=code; Object.assign(headers,values); return this;},
    end(value){if(value!=null) body=Buffer.isBuffer(value)?value:Buffer.from(String(value)); ended=true; return this;}
  };
  await handler(buffered);
  await DB.flush();
  if (!ended) throw new Error("API handler did not finish its response");
  if (body.length > 64*1024*1024) throw new Error("Response too large");
  if (!res.destroyed) { res.writeHead(status,headers); res.end(body); }
}
module.exports={validate,durableResponse};
