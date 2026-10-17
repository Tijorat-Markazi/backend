"use strict";
const fs=require("node:fs");
const path=require("node:path");
const DB=require("../db");
const Auth=require("./auth");
const FILE=path.join(__dirname,"..","data","assets.json");
const ROOT=path.join(__dirname,"..","uploads");
function register(url,scope={owner:Auth.owner()}) {
  const all=DB.get(FILE,{});all[url]=scope;DB.set(FILE,all);
}
function share(url,group) {
  const all=DB.get(FILE,{}),scope=all[url];
  if(scope && scope.owner===Auth.owner()){scope.group=group;DB.set(FILE,all);}
}
function allowed(url,core,auth) {
  const scope=DB.get(FILE,{})[url];
  if(scope?.public) return true;
  if(!auth || auth.restricted || !scope) return false;
  if(scope.owner===Auth.owner(auth)) return true;
  const actor=Auth.chatActor(auth);
  if(!actor || !scope.group) return false;
  if(scope.group.startsWith("admin:")) return ["admin","rais"].includes(actor.type) || (actor.type==="company"&&actor.id===scope.group.slice(6));
  return core.groupAllows(actor,scope.group);
}
async function serve(res,url,core,auth) {
  if(!/^\/uploads\/(?:news\/)?[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(url) || !allowed(url,core,auth)) {res.writeHead(404);return res.end("Not found");}
  const file=path.join(ROOT,url.slice("/uploads/".length));
  const real=await fs.promises.realpath(file).catch(()=>null);
  if(!real || !real.startsWith(ROOT+path.sep)){res.writeHead(404);return res.end("Not found");}
  const stat=await fs.promises.stat(real);if(stat.size>32*1024*1024){res.writeHead(413);return res.end("File too large");}
  const types={png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",gif:"image/gif",webm:"audio/webm",ogg:"audio/ogg",mp3:"audio/mpeg",m4a:"audio/mp4",wav:"audio/wav",mp4:"video/mp4",pdf:"application/pdf"};
  const ext=path.extname(real).slice(1).toLowerCase();
  res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","X-Content-Type-Options":"nosniff","Cache-Control":"private, no-store",
    "Content-Disposition":`${types[ext]&&ext!=="pdf"?"inline":"attachment"}; filename="${path.basename(real)}"`});
  return res.end(await fs.promises.readFile(real));
}
function indexLegacy(core){
  const all=DB.get(FILE,{}),add=(url,scope)=>{
    if(typeof url==="string"&&/^\/uploads\/(?:news\/)?[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(url)&&!all[url])all[url]=scope;
  };
  const docs=name=>DB.get(path.join(__dirname,"..","data",name),{});
  for(const [room,messages] of Object.entries(docs("group-chat.json")))for(const message of messages||[])add(message.att?.url,{group:room});
  for(const [company,messages] of Object.entries(docs("project-chat.json")))for(const message of messages||[])add(message.att?.url,{group:"admin:"+company});
  for(const company of core.getOrgs().companies||[])for(const item of company.showroom||[]){
    if(/\.(png|jpe?g|webp|gif)$/i.test(item.img||""))add(item.img,{public:true});
  }
  const news=docs("sector-news.json");
  const visit=value=>{if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==="object")Object.values(value).forEach(visit);else if(typeof value==="string"&&value.startsWith("/uploads/news/")&&/\.(png|jpe?g|webp|gif)$/i.test(value))add(value,{public:true});};
  visit(news);DB.set(FILE,all);
}
module.exports={register,share,allowed,serve,indexLegacy};
