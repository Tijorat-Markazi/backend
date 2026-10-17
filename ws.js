"use strict";
const {WebSocketServer,WebSocket}=require("ws");
const Auth=require("./srv/auth");
const DB=require("./db");
// ws enforces the aggregate message limit, including fragmented messages.
function attach(httpServer,opts){
  const wss=new WebSocketServer({noServer:true,maxPayload:12*1024*1024,perMessageDeflate:false});
  const conns=new Set();
  const revoke=token=>{for(const c of conns)if(c.tokenHash===token)c.close();};
  Auth.events.on("revoke",revoke);
  const hub={conns,
    broadcast(obj,where){
      // Revalidate recipients too: suspension/logout must stop existing sockets.
      for(const c of conns)c.deliver(obj,where).catch(()=>c.close());
    },
    close(){clearInterval(heartbeat);Auth.events.off("revoke",revoke);for(const c of conns)c.close();wss.close();}
  };
  httpServer.on("upgrade",async(req,socket,head)=>{
    try{
      if(req.url!==opts.path || req.headers.origin!==process.env.APP_ORIGIN || !DB.status().ready)throw new Error("origin");
      const auth=await Auth.load(req);
      if(!auth || !Auth.chatActor(auth))throw new Error("unauthorized");
      req.sessionHash=auth.tokenHash;
      wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req));
    }catch{socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");}
  });
  wss.on("connection",(ws,req)=>{
    let queue=Promise.resolve(),alive=true;
    const c={data:{},req,alive:true,tokenHash:req.sessionHash,
      async deliver(obj,where){
        await DB.flush();
        const auth=await Auth.load(req),actor=auth&&Auth.chatActor(auth);
        if(!actor)return c.close();c.data.actor=actor;
        if((!where||where(c))&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));
      },
      send(obj){c.deliver(obj).catch(()=>c.close());},
      close(){c.alive=false;ws.terminate();},
      ping(){ws.ping();}
    };
    conns.add(c);ws.on("pong",()=>{alive=true;});
    ws.on("message",(bytes,isBinary)=>{
      queue=queue.then(async()=>{
        const auth=await Auth.load(req),actor=auth&&Auth.chatActor(auth);
        if(!actor||isBinary)return c.close();
        Auth.throttle("ws:"+Auth.owner(auth),120);
        let message;try{message=JSON.parse(bytes.toString());}catch{return c.send({op:"error",error:"bad_json"});}
        c.data.actor=actor;
        await Auth.run(auth,()=>opts.onMessage(c,message));
        await DB.flush();
      }).catch(()=>c.close());
    });
    ws.on("error",()=>c.close());ws.on("close",()=>{conns.delete(c);opts.onClose?.(c);});
    c.tick=async()=>{if(!alive)return c.close();const auth=await Auth.load(req);if(!auth||!Auth.chatActor(auth))return c.close();alive=false;ws.ping();};
    opts.onOpen?.(c);
  });
  const heartbeat=setInterval(()=>{for(const c of conns)c.tick().catch(()=>c.close());},30000);heartbeat.unref();
  return hub;
}
module.exports={attach};
