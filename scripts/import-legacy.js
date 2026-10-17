"use strict";
// Explicit one-time import: mount your existing data/uploads before running.
const DB=require("../db");
async function main(){
  if(process.env.CONFIRM_LEGACY_IMPORT!=="yes")throw new Error("Set CONFIRM_LEGACY_IMPORT=yes for the one-time import");
  await DB.init({importFiles:true});
  const core=require("../core");require("../srv/auth").configure(core);
  require("../srv/assets").indexLegacy(core);await DB.flush();
  console.log("Imported missing JSON collections. Existing PostgreSQL collections were preserved.");
  console.log("Legacy email-owned private records remain inaccessible; no email-based account takeover migration is performed.");
  await DB.close();
}
main().catch(()=>{console.error("Legacy import failed; inspect source data and database availability.");process.exit(1);});
