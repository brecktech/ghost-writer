import { createServer } from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import { networkInterfaces } from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT || 8080;
const clientHTML = readFileSync(join(__dirname, "index.html"), "utf8");

function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === "IPv4" && !net.internal) return net.address;
  return "localhost";
}

const localIP = getLocalIP();
const httpServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(clientHTML);
});

const wss = new WebSocketServer({ server: httpServer });
const lobbies = new Map();
const clients = new Map();

function generateCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (lobbies.has(code));
  return code;
}
function sendTo(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function shuffle(arr) {
  const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a;
}

function sanitizeLobby(lobby) {
  return {
    code:lobby.code, hostId:lobby.hostId, targetScore:lobby.targetScore,
    players:lobby.players.map(p=>({id:p.id,name:p.name,connected:!!p.ws})),
    phase:lobby.phase, prompterIdx:lobby.prompterIdx, prompt:lobby.prompt,
    responses:lobby.responses, currentGuesserIdx:lobby.currentGuesserIdx,
    eliminatedThisRound:lobby.eliminatedThisRound, favoriteIdx:lobby.favoriteIdx,
    scores:lobby.scores, respondedPlayerIds:lobby.respondedPlayerIds||[],
    guessResult:lobby.guessResult||null, revealedAnswers:lobby.revealedAnswers||[],
    roundNumber:lobby.roundNumber||1,
  };
}

function broadcastState(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  const state = sanitizeLobby(lobby);
  for (const p of lobby.players)
    sendTo(p.ws, {type:"state", state:{...state, yourId:p.id, youResponded:(lobby._responses||{})[p.id]!=null}});
}

function findNextGuesser(lobby, afterIdx) {
  const n=lobby.players.length; let idx=(afterIdx+1)%n; const start=idx;
  do { if(idx!==lobby.prompterIdx&&!lobby.eliminatedThisRound.includes(lobby.players[idx].id)) return idx; idx=(idx+1)%n; } while(idx!==start);
  return -1;
}

function handleMessage(ws, data) {
  let msg; try{msg=JSON.parse(data);}catch{return;}
  const h = {
    create_lobby: handleCreateLobby, join_lobby: handleJoinLobby,
    reorder_players: handleReorder, update_settings: handleUpdateSettings,
    start_game: handleStartGame, submit_prompt: handleSubmitPrompt,
    submit_response: handleSubmitResponse, select_favorite: handleSelectFavorite,
    submit_guess: handleSubmitGuess, next_round: handleNextRound, play_again: handlePlayAgain,
    leave_lobby: handleLeaveLobby, kick_player: handleKickPlayer,
  };
  if (h[msg.type]) h[msg.type](ws, msg);
}

function handleCreateLobby(ws, msg) {
  const name=(msg.name||"").trim();
  if(!name||name.length>20) return sendTo(ws,{type:"error",message:"Invalid name"});
  const code=generateCode(), pid=uuidv4();
  lobbies.set(code,{code,hostId:pid,targetScore:10,players:[{id:pid,name,ws}],phase:"waiting",
    prompterIdx:0,prompt:"",responses:[],_responses:{},respondedPlayerIds:[],currentGuesserIdx:null,
    eliminatedThisRound:[],favoriteIdx:null,scores:{[pid]:0},guessResult:null,revealedAnswers:[],roundNumber:0});
  clients.set(ws,{lobbyCode:code,playerId:pid});
  sendTo(ws,{type:"joined",code,playerId:pid,isHost:true}); broadcastState(code);
}

function handleJoinLobby(ws, msg) {
  const name=(msg.name||"").trim(), code=(msg.code||"").trim();
  if(!name||name.length>20) return sendTo(ws,{type:"error",message:"Enter a valid name"});
  if(!lobbies.has(code)) return sendTo(ws,{type:"error",message:"Lobby not found"});
  const lobby=lobbies.get(code);
  if(lobby.phase!=="waiting") return sendTo(ws,{type:"error",message:"Game already in progress"});
  if(lobby.players.find(p=>p.name.toLowerCase()===name.toLowerCase())) return sendTo(ws,{type:"error",message:"Name already taken"});
  if(lobby.players.length>=20) return sendTo(ws,{type:"error",message:"Lobby is full"});
  const pid=uuidv4();
  lobby.players.push({id:pid,name,ws}); lobby.scores[pid]=0;
  clients.set(ws,{lobbyCode:code,playerId:pid});
  sendTo(ws,{type:"joined",code,playerId:pid,isHost:false}); broadcastState(code);
}

function handleLeaveLobby(ws) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby) return;
  // Remove player
  lobby.players=lobby.players.filter(p=>p.id!==info.playerId);
  delete lobby.scores[info.playerId];
  clients.delete(ws);
  sendTo(ws,{type:"left"});
  // If host left, delete the lobby and boot everyone
  if(info.playerId===lobby.hostId){
    for(const p of lobby.players) sendTo(p.ws,{type:"left"});
    lobbies.delete(info.lobbyCode);
    return;
  }
  // If no players left, clean up
  if(lobby.players.length===0){ lobbies.delete(info.lobbyCode); return; }
  broadcastState(info.lobbyCode);
}

function handleKickPlayer(ws, msg) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby) return;
  // Only host can kick, only in waiting phase
  if(lobby.hostId!==info.playerId||lobby.phase!=="waiting") return;
  const kickId=msg.playerId; if(!kickId||kickId===info.playerId) return;
  const kicked=lobby.players.find(p=>p.id===kickId);
  if(!kicked) return;
  // Remove from lobby
  lobby.players=lobby.players.filter(p=>p.id!==kickId);
  delete lobby.scores[kickId];
  // Tell the kicked player
  if(kicked.ws){ sendTo(kicked.ws,{type:"kicked"}); clients.delete(kicked.ws); }
  broadcastState(info.lobbyCode);
}

function handleReorder(ws, msg) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby||lobby.hostId!==info.playerId||!Array.isArray(msg.order)) return;
  const ordered=[];
  for(const id of msg.order){const p=lobby.players.find(pl=>pl.id===id);if(p)ordered.push(p);}
  for(const p of lobby.players){if(!ordered.find(o=>o.id===p.id))ordered.push(p);}
  lobby.players=ordered; broadcastState(info.lobbyCode);
}

function handleUpdateSettings(ws, msg) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby||lobby.hostId!==info.playerId) return;
  if(typeof msg.targetScore==="number"&&msg.targetScore>0&&msg.targetScore<=100) lobby.targetScore=Math.floor(msg.targetScore);
  broadcastState(info.lobbyCode);
}

function handleStartGame(ws) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby||lobby.hostId!==info.playerId) return;
  if(lobby.players.length<3) return sendTo(ws,{type:"error",message:"Need at least 3 players"});
  Object.assign(lobby,{phase:"prompt",prompterIdx:0,roundNumber:1,prompt:"",_responses:{},responses:[],
    respondedPlayerIds:[],eliminatedThisRound:[],favoriteIdx:null,currentGuesserIdx:null,guessResult:null,revealedAnswers:[]});
  broadcastState(info.lobbyCode);
}

function handleSubmitPrompt(ws, msg) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby||lobby.phase!=="prompt") return;
  if(lobby.players[lobby.prompterIdx].id!==info.playerId) return;
  const text=(msg.prompt||"").trim(); if(!text) return;
  lobby.prompt=text; lobby.phase="respond"; lobby._responses={}; lobby.respondedPlayerIds=[];
  broadcastState(info.lobbyCode);
}

function handleSubmitResponse(ws, msg) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby||lobby.phase!=="respond") return;
  const prompter=lobby.players[lobby.prompterIdx];
  if(info.playerId===prompter.id||lobby._responses[info.playerId]!=null) return;
  const text=(msg.response||"").trim(); if(!text) return;
  lobby._responses[info.playerId]=text; lobby.respondedPlayerIds.push(info.playerId);
  if(Object.keys(lobby._responses).length>=lobby.players.filter(p=>p.id!==prompter.id).length){
    const shuffled=shuffle(Object.entries(lobby._responses).map(([pid,t])=>({playerId:pid,text:t})));
    lobby._shuffled=shuffled; lobby.responses=shuffled.map(r=>({text:r.text}));
    lobby.phase="favorite"; lobby.favoriteIdx=null;
  }
  broadcastState(info.lobbyCode);
}

function handleSelectFavorite(ws, msg) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby||lobby.phase!=="favorite") return;
  if(lobby.players[lobby.prompterIdx].id!==info.playerId) return;
  const idx=msg.index;
  if(typeof idx!=="number"||idx<0||idx>=lobby._shuffled.length) return;
  lobby.favoriteIdx=idx;
  const favPid=lobby._shuffled[idx].playerId;
  lobby.scores[favPid]=(lobby.scores[favPid]||0)+1;
  if(lobby.scores[favPid]>=lobby.targetScore){
    lobby.phase="game_over";
    lobby.revealedAnswers=lobby._shuffled.map(r=>({text:r.text,playerId:r.playerId,playerName:lobby.players.find(p=>p.id===r.playerId)?.name}));
    broadcastState(info.lobbyCode); return;
  }
  lobby.phase="guess"; lobby.eliminatedThisRound=[]; lobby.guessResult=null;
  lobby.currentGuesserIdx=findNextGuesser(lobby,lobby.prompterIdx);
  broadcastState(info.lobbyCode);
}

function handleSubmitGuess(ws, msg) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby||lobby.phase!=="guess"||lobby.currentGuesserIdx===null) return;
  if(lobby.players[lobby.currentGuesserIdx].id!==info.playerId) return;
  const {responseIdx,playerId:guessedPid}=msg;
  const remaining=lobby._shuffled.filter(r=>!lobby.eliminatedThisRound.includes(r.playerId));
  if(responseIdx<0||responseIdx>=remaining.length) return;
  const actual=remaining[responseIdx];
  const correct=actual.playerId===guessedPid;
  const guesser=lobby.players[lobby.currentGuesserIdx];
  const guessed=lobby.players.find(p=>p.id===guessedPid);
  if(correct){
    lobby.eliminatedThisRound.push(guessedPid);
    lobby.scores[guesser.id]=(lobby.scores[guesser.id]||0)+1;
    lobby.guessResult={correct:true,guesserName:guesser.name,matchedName:guessed?.name,responseText:actual.text};
    lobby.responses=lobby._shuffled.filter(r=>!lobby.eliminatedThisRound.includes(r.playerId)).map(r=>({text:r.text}));
    if(lobby.scores[guesser.id]>=lobby.targetScore){
      lobby.phase="game_over";
      lobby.revealedAnswers=lobby._shuffled.map(r=>({text:r.text,playerId:r.playerId,playerName:lobby.players.find(p=>p.id===r.playerId)?.name}));
      broadcastState(info.lobbyCode); return;
    }
    if(lobby.players.filter(p=>p.id!==lobby.players[lobby.prompterIdx].id&&!lobby.eliminatedThisRound.includes(p.id)).length<=1){
      lobby.phase="round_end";
      lobby.revealedAnswers=lobby._shuffled.map(r=>({text:r.text,playerId:r.playerId,playerName:lobby.players.find(p=>p.id===r.playerId)?.name}));
      broadcastState(info.lobbyCode); return;
    }
  } else {
    lobby.guessResult={correct:false,guesserName:guesser.name,guessedName:guessed?.name,responseText:actual.text};
    const nextG=findNextGuesser(lobby,lobby.currentGuesserIdx);
    if(nextG===-1||nextG===lobby.currentGuesserIdx){
      lobby.phase="round_end";
      lobby.revealedAnswers=lobby._shuffled.map(r=>({text:r.text,playerId:r.playerId,playerName:lobby.players.find(p=>p.id===r.playerId)?.name}));
    } else { lobby.currentGuesserIdx=nextG; }
  }
  broadcastState(info.lobbyCode);
}

function handleNextRound(ws) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby||lobby.phase!=="round_end"||lobby.hostId!==info.playerId) return;
  lobby.prompterIdx=(lobby.prompterIdx+1)%lobby.players.length;
  lobby.roundNumber=(lobby.roundNumber||1)+1;
  Object.assign(lobby,{phase:"prompt",prompt:"",_responses:{},respondedPlayerIds:[],responses:[],
    eliminatedThisRound:[],favoriteIdx:null,currentGuesserIdx:null,guessResult:null,revealedAnswers:[]});
  broadcastState(info.lobbyCode);
}

function handlePlayAgain(ws) {
  const info=clients.get(ws); if(!info) return;
  const lobby=lobbies.get(info.lobbyCode); if(!lobby||lobby.hostId!==info.playerId) return;
  for(const p of lobby.players) lobby.scores[p.id]=0;
  Object.assign(lobby,{phase:"waiting",prompterIdx:0,roundNumber:0,prompt:"",_responses:{},respondedPlayerIds:[],
    responses:[],eliminatedThisRound:[],favoriteIdx:null,currentGuesserIdx:null,guessResult:null,revealedAnswers:[]});
  broadcastState(info.lobbyCode);
}

wss.on("connection",(ws)=>{
  ws.on("message",(data)=>handleMessage(ws,data));
  ws.on("close",()=>{
    const info=clients.get(ws);
    if(info){
      const lobby=lobbies.get(info.lobbyCode);
      if(lobby){
        const player=lobby.players.find(p=>p.id===info.playerId);
        if(player) player.ws=null;
        if(lobby.players.every(p=>!p.ws))
          setTimeout(()=>{const l=lobbies.get(info.lobbyCode);if(l&&l.players.every(p=>!p.ws))lobbies.delete(info.lobbyCode);},300000);
        broadcastState(info.lobbyCode);
      }
      clients.delete(ws);
    }
  });
  ws.isAlive=true; ws.on("pong",()=>{ws.isAlive=true;});
});
setInterval(()=>{wss.clients.forEach(ws=>{if(!ws.isAlive)return ws.terminate();ws.isAlive=false;ws.ping();});},30000);

httpServer.listen(PORT, () => {
  console.log("\n  GHOST WRITER Game Server");
  console.log("  ────────────────────────────────");
  console.log("  Players open on their phones:");
  console.log("  👉  http://" + localIP + ":" + PORT);
  console.log("  (Everyone must be on same WiFi)\n");
});
