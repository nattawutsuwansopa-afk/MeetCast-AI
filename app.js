const $=id=>document.getElementById(id);
window.addEventListener('error',e=>console.error('MeetCast UI error:',e.message,e.error||''));
window.addEventListener('unhandledrejection',e=>console.error('MeetCast async error:',e.reason||''));

const state={
  slide:null,page:0,pendingFile:null,pendingDeckId:null,objectUrl:null,reading:false,
  meetingId:null,meetingState:'idle',startedAt:0,timerHandle:null,
  recorder:null,stream:null,audioChunks:[],
  latestMeeting:null,room:null,roomParticipantId:null,roomPollHandle:null,
  decks:[],activeDeckId:null,slideTimer:null,transitioning:false,deckSettingsId:null,speechToken:0
};

function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function ext(name){const i=name.lastIndexOf('.');return i>=0?name.slice(i).toLowerCase():''}
function formatBytes(n){if(n<1024)return n+' B';if(n<1024*1024)return (n/1024).toFixed(1)+' KB';return (n/1024/1024).toFixed(1)+' MB'}
function pageText(){return (state.slide?.pages?.[state.page]||'').trim()}
function pageTotal(){return Math.max(1,state.slide?.page_count||state.slide?.pages?.length||1)}

function showView(name){const target=$('view-'+name);if(!target){console.warn('Unknown view:',name);return false}document.querySelectorAll('.view').forEach(v=>v.classList.remove('active-view'));target.classList.add('active-view');document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===name));try{if(name==='library')loadLibrary()}catch(e){console.warn('library init',e)}try{if(name==='summary'){renderSummary(state.latestMeeting);loadHistory()}}catch(e){console.warn('summary init',e)}window.scrollTo({top:0,behavior:'smooth'});return true;}
function bindCriticalNavigation(){document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>{showView(b.dataset.view);closeSidebar();});if($('menuBtn'))$('menuBtn').onclick=()=>{$('sidebar')?.classList.contains('open')?closeSidebar():openSidebar()};if($('closeSidebarBtn'))$('closeSidebarBtn').onclick=closeSidebar;if($('sidebarOverlay'))$('sidebarOverlay').onclick=closeSidebar;if($('topSettingsBtn'))$('topSettingsBtn').onclick=()=>{showView('settings');closeSidebar()};if($('backMeetingBtn'))$('backMeetingBtn').onclick=()=>showView('meeting');}bindCriticalNavigation();


const roomSessionKey='meetcast_room_session_v25';
function saveRoomSession(){
  if(!state.room||!state.roomParticipantId){localStorage.removeItem(roomSessionKey);return}
  localStorage.setItem(roomSessionKey,JSON.stringify({code:state.room.code,participant_id:state.roomParticipantId}));
}
function clearRoomSession(){
  localStorage.removeItem(roomSessionKey);state.room=null;state.roomParticipantId=null;
  if(state.roomPollHandle){clearInterval(state.roomPollHandle);state.roomPollHandle=null}
  renderRoomState();
}
async function roomJSON(url,options={}){
  const r=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
  const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch(e){data={detail:text}}
  if(!r.ok)throw new Error(data.detail||text||'ดำเนินการไม่สำเร็จ');
  return data;
}
function normalizeRoomInput(v){return String(v||'').toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,6)}
function roomParticipantRows(){return Array.isArray(state.room?.participants)?state.room.participants:[]}
function renderRoomState(){
  const room=state.room;
  $('activeRoomCard')?.classList.toggle('hidden',!room);
  $('meetingRoomBadge')?.classList.toggle('hidden',!room);
  if(!room)return;
  if($('activeRoomTitle'))$('activeRoomTitle').textContent=room.title||'ห้องประชุม';
  if($('activeRoomCode'))$('activeRoomCode').textContent=room.code||'------';
  if($('activeRoomURL'))$('activeRoomURL').textContent=room.lan_url||'ไม่พบ LAN IP — ยังทดลองบนเครื่องนี้ได้';
  if($('participantCount'))$('participantCount').textContent=`${room.participant_count||roomParticipantRows().length} คน`;
  if($('meetingRoomCode'))$('meetingRoomCode').textContent=room.code||'------';
  if($('meetingRoomPeople'))$('meetingRoomPeople').textContent=`${room.participant_count||roomParticipantRows().length} คน`;
  if($('participantList'))$('participantList').innerHTML=roomParticipantRows().map(p=>`<div class="participant-row"><div class="participant-avatar">${escapeHtml((p.name||'?').trim().slice(0,1).toUpperCase())}</div><div><b>${escapeHtml(p.name)}</b><span>${p.role==='host'?'เจ้าของห้อง':'ผู้เข้าร่วม'}</span></div><em>${p.id===state.roomParticipantId?'คุณ':''}</em></div>`).join('')||'<div class="participant-empty">ยังไม่มีผู้เข้าร่วม</div>';
}
async function refreshRoom(){
  if(!state.room?.code)return;
  try{
    const data=await roomJSON(`/api/room/status?code=${encodeURIComponent(state.room.code)}`);
    state.room=data.room;renderRoomState();saveRoomSession();
  }catch(e){
    if(String(e.message).includes('ไม่พบห้อง'))clearRoomSession();
  }
}
function startRoomPolling(){
  if(state.roomPollHandle)clearInterval(state.roomPollHandle);
  state.roomPollHandle=setInterval(refreshRoom,2500);
}
async function createMeetingRoom(){
  const hostName=$('createRoomName').value.trim();
  const title=$('createRoomTitle').value.trim()||$('meetingTitle').value.trim()||'การประชุม MeetCast AI';
  if(!hostName)return toast('กรุณาใส่ชื่อผู้สร้างห้อง');
  $('createRoomBtn').disabled=true;$('createRoomBtn').textContent='กำลังสร้าง...';
  try{
    if(state.room)await leaveMeetingRoom(false);
    const data=await roomJSON('/api/room/create',{method:'POST',body:JSON.stringify({host_name:hostName,title})});
    state.room=data.room;state.roomParticipantId=data.participant_id;saveRoomSession();renderRoomState();startRoomPolling();
    $('meetingTitle').value=state.room.title||title;
    toast(`สร้างห้อง ${state.room.code} แล้ว`);
  }catch(e){toast(e.message)}finally{$('createRoomBtn').disabled=false;$('createRoomBtn').textContent='＋ สร้างห้อง'}
}
async function joinMeetingRoom(){
  const code=normalizeRoomInput($('joinRoomCode').value);$('joinRoomCode').value=code;
  const name=$('joinDisplayName').value.trim();
  if(code.length!==6)return toast('กรุณาใส่รหัสห้อง 6 ตัว');
  if(!name)return toast('กรุณาใส่ชื่อผู้เข้าร่วม');
  $('joinRoomBtn').disabled=true;$('joinRoomBtn').textContent='กำลังเข้าร่วม...';
  try{
    if(state.room)await leaveMeetingRoom(false);
    const data=await roomJSON('/api/room/join',{method:'POST',body:JSON.stringify({code,name})});
    state.room=data.room;state.roomParticipantId=data.participant_id;saveRoomSession();renderRoomState();startRoomPolling();
    $('meetingTitle').value=state.room.title||$('meetingTitle').value;showView('meeting');toast(`เข้าร่วมห้อง ${state.room.code} แล้ว`);
  }catch(e){toast(e.message)}finally{$('joinRoomBtn').disabled=false;$('joinRoomBtn').textContent='เข้าร่วมประชุม'}
}
async function leaveMeetingRoom(showMessage=true){
  const code=state.room?.code,id=state.roomParticipantId;
  if(code&&id){
    await roomJSON('/api/room/leave',{method:'POST',body:JSON.stringify({code,participant_id:id})}).catch(()=>{});
  }
  clearRoomSession();if(showMessage)toast('ออกจากห้องแล้ว');
}
async function restoreRoomSession(){
  let saved=null;try{saved=JSON.parse(localStorage.getItem(roomSessionKey)||'null')}catch(e){}
  if(!saved?.code||!saved?.participant_id)return;
  try{
    const data=await roomJSON(`/api/room/status?code=${encodeURIComponent(saved.code)}`);
    const exists=(data.room?.participants||[]).some(p=>p.id===saved.participant_id);
    if(!exists){clearRoomSession();return}
    state.room=data.room;state.roomParticipantId=saved.participant_id;renderRoomState();startRoomPolling();
  }catch(e){clearRoomSession()}
}
async function copyTextValue(text,label){
  if(!text)return toast('ไม่มีข้อมูลให้คัดลอก');
  try{await navigator.clipboard.writeText(text);toast(`คัดลอก${label}แล้ว`)}catch(e){toast('คัดลอกไม่สำเร็จ')}
}
if($('openJoinBtn'))$('openJoinBtn').onclick=()=>showView('join');
if($('joinBackMeetingBtn'))$('joinBackMeetingBtn').onclick=()=>showView('meeting');
if($('createRoomBtn'))$('createRoomBtn').onclick=createMeetingRoom;
if($('joinRoomBtn'))$('joinRoomBtn').onclick=joinMeetingRoom;
if($('joinRoomCode'))$('joinRoomCode').oninput=()=>{$('joinRoomCode').value=normalizeRoomInput($('joinRoomCode').value)};
if($('leaveRoomBtn'))$('leaveRoomBtn').onclick=()=>leaveMeetingRoom(true);
if($('copyRoomCodeBtn'))$('copyRoomCodeBtn').onclick=()=>copyTextValue(state.room?.code,'รหัสห้อง');
if($('copyRoomLinkBtn'))$('copyRoomLinkBtn').onclick=()=>copyTextValue(state.room?.lan_url,'ลิงก์');
if($('openParticipantPreviewBtn'))$('openParticipantPreviewBtn').onclick=()=>{
  if(!state.room?.code)return toast('ยังไม่ได้สร้างห้อง');
  window.open(`/join?room=${encodeURIComponent(state.room.code)}`,'_blank','noopener');
};
restoreRoomSession();


const commanderStorageKey='meetcast_commander_profile_v26';
const commanderDefaults={
  visible:true,
  unitTh:'ศูนย์ค้นหาและช่วยชีวิต',
  unitEn:'SEARCH AND RESCUE CENTER',
  name:'พล.อ.ต.อิษฐ์ สงวนศักดิ์',
  position:'ผบ.ศศว.ศปอ.',
  role:'ผู้บังคับบัญชาแจ้งหรือสั่งการในที่ประชุม',
  photo:'commander-default.png'
};
function readCommanderProfile(){
  try{
    const saved=JSON.parse(localStorage.getItem(commanderStorageKey)||'null');
    return {...commanderDefaults,...(saved||{})};
  }catch(e){
    return {...commanderDefaults};
  }
}
function saveCommanderProfile(profile){
  localStorage.setItem(commanderStorageKey,JSON.stringify(profile));
}
function fillCommanderInputs(profile){
  $('commanderUnitThInput').value=profile.unitTh||'';
  $('commanderUnitEnInput').value=profile.unitEn||'';
  $('commanderNameInput').value=profile.name||'';
  $('commanderPositionInput').value=profile.position||'';
  $('commanderRoleInput').value=profile.role||'';
  $('commanderVisibleToggle').checked=profile.visible!==false;
}
function renderCommanderProfile(){
  const profile=readCommanderProfile();
  $('commanderUnitThView').textContent=profile.unitTh||'';
  $('commanderUnitEnView').textContent=profile.unitEn||'';
  $('commanderNameView').textContent=profile.name||'';
  $('commanderPositionView').textContent=profile.position||'';
  $('commanderRoleView').textContent=profile.role||'';
  $('commanderPhotoView').src=profile.photo||'commander-default.png';
  $('commanderCard').classList.toggle('hidden',profile.visible===false);
  fillCommanderInputs(profile);
}
function updateCommanderProfile(patch){
  const next={...readCommanderProfile(),...patch};
  saveCommanderProfile(next);
  renderCommanderProfile();
}
function bindCommanderInputs(){
  $('commanderUnitThInput').oninput=()=>updateCommanderProfile({unitTh:$('commanderUnitThInput').value});
  $('commanderUnitEnInput').oninput=()=>updateCommanderProfile({unitEn:$('commanderUnitEnInput').value});
  $('commanderNameInput').oninput=()=>updateCommanderProfile({name:$('commanderNameInput').value});
  $('commanderPositionInput').oninput=()=>updateCommanderProfile({position:$('commanderPositionInput').value});
  $('commanderRoleInput').oninput=()=>updateCommanderProfile({role:$('commanderRoleInput').value});
  $('commanderVisibleToggle').onchange=()=>updateCommanderProfile({visible:$('commanderVisibleToggle').checked});
  $('changeCommanderPhotoBtn').onclick=()=>$('commanderPhotoInput').click();
  $('commanderPhotoInput').onchange=e=>{
    const file=e.target.files?.[0];
    if(!file)return;
    if(!file.type.startsWith('image/'))return toast('รองรับเฉพาะรูปภาพผู้บังคับบัญชา');
    if(file.size>10*1024*1024)return toast('รูปผู้บังคับบัญชาต้องไม่เกิน 10 MB');
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        updateCommanderProfile({photo:String(reader.result||'')});
        toast('เปลี่ยนรูปผู้บังคับบัญชาแล้ว');
      }catch(err){
        toast('ไฟล์ใหญ่เกินพื้นที่จัดเก็บในโปรแกรม');
      }
    };
    reader.readAsDataURL(file);
  };
  $('resetCommanderBtn').onclick=()=>{
    saveCommanderProfile({...commanderDefaults});
    renderCommanderProfile();
    toast('รีเซ็ตข้อมูลผู้บังคับบัญชาแล้ว');
  };
}

renderCommanderProfile();
bindCommanderInputs();


const presentationStorageKey='meetcast_presentation_profile_v28';
const presentationDefaults={
  visible:true,
  sync:true,
  title:'ประชุมศูนย์ค้นหาและช่วยชีวิต',
  command:'กองบัญชาการควบคุมการปฏิบัติทางอากาศ',
  round:'ครั้งที่ ๒/๖๙',
  dateTime:'ในวันพุธที่ ๑๑ มี.ค.๖๙, ๐๙๐๐',
  location:'ณ ห้องประชุม กบค.ศกป.คปอ.',
  agenda14:[
    '๑. เรื่อง ประธานแจ้งให้ที่ประชุมทราบ',
    '๒. เรื่อง สรุปผลการประชุม ทอ.ครั้งที่ ๒/๖๙',
    '๓. เรื่อง กิจกรรมนิรภัยภาคพื้น',
    '๔. เรื่อง สถานภาพกำลังพล'
  ].join('\n'),
  workTopic:'๕. เรื่อง ผลการปฏิบัติงานที่สำคัญประจำเดือน มี.ค.๖๙ การพัฒนาหน่วย และกำลังพล แผนการปฏิบัติงานเดือน เม.ย.๖๙ ปัญหาข้อขัดข้อง และข้อเสนอแนะ',
  presenters:[
    'ผธก.ศคว.คปอ.',
    'ฝสอ.ผนน.ศคว.คปอ.',
    'ฝพด.ผนน.ศคว.คปอ.',
    'กปคว.ศคว.ฯ / กฝคว.ศคว.ฯ',
    'จนท.ค้นหาและช่วยชีวิต'
  ].join('\n'),
  agenda67:[
    '๖. เรื่องอื่น ๆ',
    '๗. เรื่อง ผู้บังคับบัญชาแจ้งหรือสั่งการในที่ประชุม'
  ].join('\n'),
  workSlide:4
};
function readPresentationProfile(){
  try{
    const saved=JSON.parse(localStorage.getItem(presentationStorageKey)||'null');
    return {...presentationDefaults,...(saved||{})};
  }catch(e){
    return {...presentationDefaults};
  }
}
function savePresentationProfile(profile){
  localStorage.setItem(presentationStorageKey,JSON.stringify(profile));
}
function fillPresentationInputs(p){
  $('presentationVisibleToggle').checked=p.visible!==false;
  $('presentationSyncToggle').checked=p.sync!==false;
  $('presentationTitleInput').value=p.title||'';
  $('presentationCommandInput').value=p.command||'';
  $('presentationRoundInput').value=p.round||'';
  $('presentationDateTimeInput').value=p.dateTime||'';
  $('presentationLocationInput').value=p.location||'';
  $('presentationAgenda14Input').value=p.agenda14||'';
  $('presentationWorkTopicInput').value=p.workTopic||'';
  $('presentationPresentersInput').value=p.presenters||'';
  $('presentationAgenda67Input').value=p.agenda67||'';
  $('presentationWorkSlideInput').value=String(p.workSlide||4);
}
function presentationTopicForPage(pageNumber,p){
  const workSlide=Math.max(1,Number(p.workSlide||4));
  if(!p.sync){
    return {title:'โหมดนำเสนอ',detail:p.workTopic||'',presenters:false,live:false};
  }
  if(pageNumber===1){
    return {title:'ศูนย์ค้นหาและช่วยชีวิต',detail:'SEARCH AND RESCUE CENTER',presenters:false,live:false};
  }
  if(pageNumber===2){
    return {title:p.title||'การประชุม',detail:[p.command,p.round,p.dateTime,p.location].filter(Boolean).join('\n'),presenters:false,live:false};
  }
  if(pageNumber===3){
    return {title:'ระเบียบวาระการประชุม ๑–๔',detail:p.agenda14||'',presenters:false,live:false};
  }
  if(pageNumber===workSlide){
    return {title:'กำลังนำเสนอผลงาน',detail:p.workTopic||'',presenters:true,live:true};
  }
  if(pageNumber===5){
    return {title:'ระเบียบวาระการประชุม ๖–๗',detail:p.agenda67||'',presenters:false,live:false};
  }
  return {title:`สไลด์ ${pageNumber}`,detail:pageText()||'กำลังนำเสนอข้อมูลจากสไลด์',presenters:false,live:true};
}
function renderPresentation(){
  const p=readPresentationProfile();
  const card=$('presentationCard');
  card.classList.toggle('hidden',p.visible===false);
  fillPresentationInputs(p);
  $('presentationMeetingTitleView').textContent=p.title||'การประชุม';
  $('presentationCommandView').textContent=p.command||'';
  $('presentationRoundView').textContent=p.round||'';
  $('presentationDateTimeView').textContent=p.dateTime||'';
  $('presentationLocationView').textContent=p.location||'';

  const current=presentationTopicForPage(state.slide?state.page+1:1,p);
  $('presentationCurrentTopic').textContent=current.title;
  $('presentationCurrentDetail').textContent=current.detail||'';
  $('presentationStateBadge').textContent=current.live?'กำลังนำเสนอ':'พร้อมนำเสนอ';
  $('presentationStateBadge').classList.toggle('live',!!current.live);

  const presenterBlock=$('presentationPresenterBlock');
  presenterBlock.classList.toggle('hidden',!current.presenters);
  $('presentationPresenterList').innerHTML=(p.presenters||'')
    .split(/\r?\n/)
    .map(x=>x.trim())
    .filter(Boolean)
    .map(x=>`<div class="presentation-presenter-row">• ${escapeHtml(x)}</div>`)
    .join('');

  if(p.visible!==false && p.sync!==false && state.slide){
    $('meetingTitle').value=p.title||$('meetingTitle').value;
  }
}
function updatePresentationProfile(patch){
  const next={...readPresentationProfile(),...patch};
  savePresentationProfile(next);
  renderPresentation();
}
function bindPresentationSettings(){
  $('presentationVisibleToggle').onchange=()=>updatePresentationProfile({visible:$('presentationVisibleToggle').checked});
  $('presentationSyncToggle').onchange=()=>updatePresentationProfile({sync:$('presentationSyncToggle').checked});
  $('presentationTitleInput').oninput=()=>updatePresentationProfile({title:$('presentationTitleInput').value});
  $('presentationCommandInput').oninput=()=>updatePresentationProfile({command:$('presentationCommandInput').value});
  $('presentationRoundInput').oninput=()=>updatePresentationProfile({round:$('presentationRoundInput').value});
  $('presentationDateTimeInput').oninput=()=>updatePresentationProfile({dateTime:$('presentationDateTimeInput').value});
  $('presentationLocationInput').oninput=()=>updatePresentationProfile({location:$('presentationLocationInput').value});
  $('presentationAgenda14Input').oninput=()=>updatePresentationProfile({agenda14:$('presentationAgenda14Input').value});
  $('presentationWorkTopicInput').oninput=()=>updatePresentationProfile({workTopic:$('presentationWorkTopicInput').value});
  $('presentationPresentersInput').oninput=()=>updatePresentationProfile({presenters:$('presentationPresentersInput').value});
  $('presentationAgenda67Input').oninput=()=>updatePresentationProfile({agenda67:$('presentationAgenda67Input').value});
  $('presentationWorkSlideInput').oninput=()=>updatePresentationProfile({workSlide:Math.max(1,Number($('presentationWorkSlideInput').value||4))});
  $('previewPresentationBtn').onclick=()=>{showView('meeting');renderPresentation();toast('เปิดดูหมวดนำเสนอแล้ว')};
  $('resetPresentationBtn').onclick=()=>{
    savePresentationProfile({...presentationDefaults});
    renderPresentation();
    toast('รีเซ็ตหมวดนำเสนอตามไฟล์แนบแล้ว');
  };
}

renderPresentation();
bindPresentationSettings();

function deckStorageKey(){return 'meetcast_slide_decks_v13'}
function saveDecks(){localStorage.setItem(deckStorageKey(),JSON.stringify(state.decks))}
function loadDecks(){
  try{state.decks=JSON.parse(localStorage.getItem(deckStorageKey())||'[]')}catch(e){state.decks=[]}
  if(!Array.isArray(state.decks))state.decks=[];state.decks=state.decks.map(d=>({...d,interval:Number(d.interval||5),auto:d.auto!==false,loop:!!d.loop}));
  if(!state.decks.length)addDeck(false);
  state.activeDeckId=state.decks[0]?.id||null;
  renderDecks();
}
function addDeck(render=true){
  const deck={id:'deck_'+Date.now()+'_'+Math.random().toString(16).slice(2),name:'',slide:null,interval:5,auto:true,loop:false};
  state.decks.push(deck);
  state.activeDeckId=deck.id;
  saveDecks();
  if(render)renderDecks();
  return deck;
}
function activeDeck(){return state.decks.find(d=>d.id===state.activeDeckId)||state.decks[0]||null}
function renderDecks(){
  const box=$('deckGrid');
  box.innerHTML=state.decks.map((d,i)=>`<div class="deck-card ${d.id===state.activeDeckId?'active':''}" data-deck="${d.id}">
    <input class="deck-title-input" data-deck-name="${d.id}" value="${escapeHtml(d.name||'')}" placeholder="กอง ${i+1} • ตั้งชื่อภายหลังได้">
    <div class="deck-file">${d.slide?`📎 ${escapeHtml(d.slide.name)} • ${d.slide.page_count||1} หน้า`:'ยังไม่ได้แนบสไลด์'}</div>
    <div class="deck-setting-summary">Auto Slide: ${d.auto?'เปิด':'ปิด'} • ไม่มีข้อความรอ ${d.interval||5} วิ${d.loop?' • วนซ้ำ':''}</div>
    <div class="deck-actions">
      <button data-open-deck="${d.id}">${d.slide?'เปิดกองนี้':'เลือกกอง'}</button>
      <button class="primary" data-attach-deck="${d.id}">＋ แนบสไลด์</button>
      <button data-settings-deck="${d.id}" title="ตั้งค่ากอง">⚙️</button>
      ${state.decks.length>1?`<button class="deck-remove" data-remove-deck="${d.id}" title="ลบกอง">✕</button>`:''}
    </div>
  </div>`).join('');
  box.querySelectorAll('[data-deck-name]').forEach(inp=>inp.oninput=()=>{
    const d=state.decks.find(x=>x.id===inp.dataset.deckName);if(d){d.name=inp.value;saveDecks()}
  });
  box.querySelectorAll('[data-open-deck]').forEach(b=>b.onclick=()=>selectDeck(b.dataset.openDeck));
  box.querySelectorAll('[data-attach-deck]').forEach(b=>b.onclick=()=>openFilePicker(b.dataset.attachDeck));
  box.querySelectorAll('[data-remove-deck]').forEach(b=>b.onclick=()=>removeDeck(b.dataset.removeDeck));box.querySelectorAll('[data-settings-deck]').forEach(b=>b.onclick=()=>openDeckSettings(b.dataset.settingsDeck));
}
function selectDeck(id){
  const d=state.decks.find(x=>x.id===id);if(!d)return;
  state.activeDeckId=id;
  if(d.slide){state.slide=d.slide;state.page=0;renderSlide();toast('เปิดกองสไลด์แล้ว')}
  renderDecks();$('deckManagerModal')?.classList.add('hidden');
}
function removeDeck(id){
  const d=state.decks.find(x=>x.id===id);if(!d)return;
  if(d.slide&&!confirm('ลบกองนี้ออกจากรายการ? ไฟล์ต้นฉบับในคลังจะยังอยู่'))return;
  state.decks=state.decks.filter(x=>x.id!==id);
  if(!state.decks.length)addDeck(false);
  if(state.activeDeckId===id)state.activeDeckId=state.decks[0].id;
  saveDecks();renderDecks();
  const a=activeDeck();
  if(a?.slide){state.slide=a.slide;state.page=0;renderSlide()}
}
function openFilePicker(deckId){
  if(deckId)state.activeDeckId=deckId;
  state.pendingDeckId=state.activeDeckId||activeDeck()?.id||addDeck().id;
  $('fileInput').click();
}
$('addDeckBtn').onclick=()=>addDeck();
$('attachTopBtn').onclick=()=>openFilePicker(state.activeDeckId);
$('attachCenterBtn').onclick=()=>openFilePicker(state.activeDeckId);
$('libraryAttachBtn').onclick=()=>{showView('meeting');setTimeout(()=>openFilePicker(state.activeDeckId),80)};

$('deckManagerBtn').onclick=()=>{$('deckManagerModal').classList.remove('hidden');renderDecks()};
$('closeDeckManagerBtn').onclick=()=>$('deckManagerModal').classList.add('hidden');
$('deckManagerModal').addEventListener('click',e=>{if(e.target===$('deckManagerModal'))$('deckManagerModal').classList.add('hidden')});

$('fileInput').onchange=e=>prepareFile(e.target.files?.[0]);
['dragenter','dragover'].forEach(ev=>$('dropZone').addEventListener(ev,e=>{e.preventDefault();$('dropZone').style.borderColor='#2f73f3'}));
['dragleave','drop'].forEach(ev=>$('dropZone').addEventListener(ev,e=>{$('dropZone').style.borderColor='#bdd2ec'}));
$('dropZone').addEventListener('drop',e=>{e.preventDefault();state.pendingDeckId=state.activeDeckId||activeDeck()?.id;prepareFile(e.dataTransfer.files?.[0])});

function prepareFile(file){
  if(!file)return;
  state.pendingFile=file;
  if(!state.pendingDeckId)state.pendingDeckId=state.activeDeckId||activeDeck()?.id;
  const d=state.decks.find(x=>x.id===state.pendingDeckId);
  $('confirmMeta').innerHTML=`<b>${escapeHtml(file.name)}</b><br>กอง: ${escapeHtml(d?.name||'ยังไม่ตั้งชื่อ')}<br>ประเภท: ${escapeHtml(file.type||ext(file.name)||'ไม่ระบุ')}<br>ขนาด: ${formatBytes(file.size)}`;
  $('confirmModal').classList.remove('hidden')
}
$('cancelConfirmBtn').onclick=()=>{state.pendingFile=null;state.pendingDeckId=null;$('confirmModal').classList.add('hidden');$('fileInput').value=''};
$('confirmFileBtn').onclick=async()=>{
  const file=state.pendingFile;if(!file)return;
  $('confirmFileBtn').disabled=true;$('confirmFileBtn').textContent='กำลังนำเข้า...';
  try{
    const fd=new FormData();fd.append('file',file);
    const r=await fetch('/api/upload',{method:'POST',body:fd});const data=await r.json();if(!r.ok)throw new Error(data.detail||'นำเข้าไฟล์ไม่สำเร็จ');
    state.slide=data;state.page=0;
    const deck=state.decks.find(x=>x.id===state.pendingDeckId)||activeDeck();
    if(deck){deck.slide=data;state.activeDeckId=deck.id;saveDecks()}
    state.pendingFile=null;state.pendingDeckId=null;$('confirmModal').classList.add('hidden');$('fileInput').value='';
    renderDecks();renderSlide();toast('ยืนยันและแสดงสไลด์แล้ว');
  }catch(e){toast(e.message)}finally{$('confirmFileBtn').disabled=false;$('confirmFileBtn').textContent='✓ ยืนยันและแสดงผล'}
};

function renderSlide(){
  const s=state.slide;if(!s)return;
  $('slideMeta').textContent=`${s.name} • ${formatBytes(s.size)}${s.preview_kind==='slides'?' • PowerPoint '+pageTotal()+' สไลด์':''}`;$('pageCount').textContent=`${state.page+1} / ${pageTotal()}`;
  $('dropZone').classList.add('hidden');$('viewerWrap').classList.remove('hidden');
  ['pdfViewer','imageViewer','textViewer'].forEach(id=>$(id).classList.add('hidden'));
  const e=s.ext.toLowerCase();
  const kind=s.preview_kind||((e==='.pdf')?'pdf':(['.png','.jpg','.jpeg','.webp','.bmp','.gif'].includes(e)?'image':'text'));
  if(kind==='slides'){
    const pagePreview=s.page_previews?.[state.page]||`${s.preview}${s.preview.includes('?')?'&':'?'}page=${state.page+1}`;
    $('imageViewer').src=`${pagePreview}${pagePreview.includes('?')?'&':'?'}v=${state.page}`;$('imageViewer').classList.remove('hidden');
  }else if(kind==='pdf'){
    const frame=$('pdfViewer');
    const src=`${s.preview}#page=${state.page+1}&toolbar=0&navpanes=0&scrollbar=0&zoom=page-fit`;
    frame.src='about:blank';
    requestAnimationFrame(()=>{frame.src=src});
    frame.classList.remove('hidden');
  }else if(kind==='image'){
    $('imageViewer').src=s.preview;$('imageViewer').classList.remove('hidden');
  }else{
    const text=pageText()||`ไฟล์ ${s.name}\n\nนำเข้าไฟล์แล้ว แต่เครื่องนี้ยังไม่มี PowerPoint/LibreOffice สำหรับสร้างภาพสไลด์จริง`;
    $('textViewer').textContent=text;$('textViewer').classList.remove('hidden');
  }
  $('readStatus').textContent=pageText()?`พร้อมอ่านหน้า ${state.page+1}`:'หน้านี้ไม่พบข้อความสำหรับอ่าน';
  renderPresentation();
}
function transitionDelay(){return 360}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function slideToPage(target,direction='next'){
  if(!state.slide||state.transitioning||target<0||target>=pageTotal()||target===state.page)return false;
  state.transitioning=true;
  const wrap=$('viewerWrap');
  const outClass=direction==='next'?'v17-out-right':'v17-out-left';
  const inClass=direction==='next'?'v17-in-left':'v17-in-right';
  wrap.classList.remove('slide-out-left','slide-in-right','slide-out-right','slide-in-left','v17-out-right','v17-in-left','v17-out-left','v17-in-right');
  void wrap.offsetWidth;wrap.classList.add(outClass);
  await wait(transitionDelay());
  state.page=target;renderSlide();
  wrap.classList.remove(outClass);void wrap.offsetWidth;wrap.classList.add(inClass);
  await wait(transitionDelay());
  wrap.classList.remove(inClass);state.transitioning=false;return true;
}
$('prevBtn').onclick=async()=>{stopReading();if(state.slide&&state.page>0)await slideToPage(state.page-1,'prev')};
$('nextBtn').onclick=async()=>{stopReading();if(state.slide&&state.page<pageTotal()-1)await slideToPage(state.page+1,'next')};
$('openOriginalBtn').onclick=()=>{if(state.slide)window.open(state.slide.preview,'_blank')};

function detectSpeechLang(text){
  const mode=$('languageMode').value;
  if(mode==='th')return'th-TH';if(mode==='en')return'en-US';if(mode==='ja')return'ja-JP';if(mode==='zh')return'zh-CN';
  if(/[฀-๿]/.test(text))return'th-TH';if(/[぀-ヿ]/.test(text))return'ja-JP';if(/[一-鿿]/.test(text))return'zh-CN';return'en-US';
}
function selectedSlideVoice(){
  if(!('speechSynthesis' in window))return null;
  const saved=localStorage.getItem('meetcast_slide_voice_v18')||'';
  if(!saved)return null;
  return speechSynthesis.getVoices().find(v=>v.voiceURI===saved||v.name===saved)||null;
}
function chooseSpeechVoice(lang){
  const selected=selectedSlideVoice();
  if(selected)return selected;
  const voices=speechSynthesis.getVoices();
  const exact=voices.filter(v=>v.lang.toLowerCase()===lang.toLowerCase());
  const base=voices.filter(v=>v.lang.toLowerCase().startsWith(lang.slice(0,2).toLowerCase()));
  return exact.find(v=>v.localService)||exact[0]||base.find(v=>v.localService)||base[0]||voices[0];
}
function normalizeSpeechText(text){
  return String(text||'')
    .replace(/[•●▪◦■□◆◇▶►➤]+/g,' ')
    .replace(/\s*[-–—]\s*/g,', ')
    .replace(/([:：])\s*/g,'$1 ')
    .replace(/\s+/g,' ')
    .replace(/([.!?。！？])(?=\S)/g,'$1 ')
    .trim();
}
function speechChunks(text,maxLen=125){
  const cleaned=normalizeSpeechText(text);
  if(!cleaned)return[];
  const units=cleaned
    .split(/(?<=[.!?。！？])\s+|(?<=ค่ะ|ครับ|นะครับ|นะคะ|แล้ว|ดังนี้)\s+/)
    .map(x=>x.trim())
    .filter(Boolean);
  const chunks=[];
  let current='';
  for(const unit of units){
    const candidate=(current+' '+unit).trim();
    if(candidate.length<=maxLen){
      current=candidate;
      continue;
    }
    if(current)chunks.push(current);
    if(unit.length<=maxLen){
      current=unit;
      continue;
    }
    const words=unit.split(/\s+/);
    let part='';
    for(const word of words){
      const next=(part+' '+word).trim();
      if(next.length<=maxLen){part=next}
      else{
        if(part)chunks.push(part);
        if(word.length>maxLen){
          for(let i=0;i<word.length;i+=maxLen)chunks.push(word.slice(i,i+maxLen));
          part='';
        }else part=word;
      }
    }
    current=part;
  }
  if(current)chunks.push(current);
  return chunks;
}
function currentVoiceRate(){
  const mode=localStorage.getItem('meetcast_voice_clarity_mode_v27')||'clear';
  const explicit=Number(localStorage.getItem('meetcast_slide_voice_rate_v18')||'0.9');
  const defaults={clear:0.90,normal:1.00,brief:1.08};
  return Number.isFinite(explicit)&&explicit>0?explicit:(defaults[mode]||0.90);
}
function currentVoicePause(){
  const ms=Number(localStorage.getItem('meetcast_voice_pause_v27')||'140');
  return Math.max(40,Math.min(500,ms||140));
}
function speakSlide(text,onDone){
  if(!('speechSynthesis' in window)||!text.trim()){onDone();return}
  const token=++state.speechToken;
  const chunks=speechChunks(text);
  const rate=currentVoiceRate();
  const pause=currentVoicePause();
  speechSynthesis.cancel();
  speechSynthesis.resume();
  let i=0,finished=false;

  const finish=()=>{
    if(finished)return;
    finished=true;
    if(token===state.speechToken)onDone();
  };

  const speakNext=()=>{
    if(token!==state.speechToken||!state.reading)return;
    if(i>=chunks.length){finish();return}
    const chunk=chunks[i++];
    const u=new SpeechSynthesisUtterance(chunk);
    u.lang=detectSpeechLang(chunk);
    const voice=chooseSpeechVoice(u.lang);
    if(voice)u.voice=voice;
    u.rate=rate;
    u.pitch=1;
    u.volume=1;
    u.onstart=()=>{
      if($('voiceQualityStatus'))$('voiceQualityStatus').textContent=`กำลังอ่านด้วย ${voice?.name||'เสียงระบบ'} • ${rate.toFixed(2)}x`;
    };
    u.onend=()=>setTimeout(speakNext,pause);
    u.onerror=()=>setTimeout(speakNext,pause);
    speechSynthesis.speak(u);
  };

  // Give Windows/browser TTS a short moment to settle before the first phrase.
  setTimeout(speakNext,60);
}
function autoSlideSeconds(){const d=activeDeck();return Math.max(1,Number(d?.interval||$('slideIntervalSetting')?.value||5))}
async function advanceAfterRead(){
  if(!state.reading)return;
  if(state.page>=pageTotal()-1){
    const d=activeDeck();
    if(d?.loop&&pageTotal()>1){await slideToPage(0,'next');setTimeout(readCurrentSlide,220);return}
    stopReading();$('readStatus').textContent='อ่านครบทุกสไลด์แล้ว';$('assistantStatus').textContent='อ่านสไลด์ครบแล้ว';return;
  }
  await slideToPage(state.page+1,'next');
  if(state.reading)setTimeout(readCurrentSlide,220);
}
function readCurrentSlide(){
  clearTimeout(state.slideTimer);
  if(!state.reading)return;
  const text=pageText();
  $('readStatus').textContent=text?`กำลังอ่านสไลด์ ${state.page+1}`:`สไลด์ ${state.page+1} ไม่มีข้อความ • รอ ${autoSlideSeconds()} วินาที`;
  $('assistantStatus').textContent=text?`กำลังอ่านสไลด์หน้า ${state.page+1}`:`กำลังแสดงสไลด์หน้า ${state.page+1}`;
  if(text){
    speakSlide(text,()=>{
      if(state.reading)advanceAfterRead();
    });
  }else{
    state.slideTimer=setTimeout(advanceAfterRead,autoSlideSeconds()*1000);
  }
}
function startReading(){
  if(!state.slide)return toast('แนบสไลด์ก่อน');
  const d=activeDeck();if(d&&d.auto===false)return toast('กองนี้ปิด Auto Slide อยู่');
  state.reading=true;readCurrentSlide();
}
function stopReading(){
  state.reading=false;clearTimeout(state.slideTimer);state.slideTimer=null;state.speechToken++;
  if('speechSynthesis' in window)speechSynthesis.cancel();
  $('readStatus').textContent=state.slide?'พร้อมอ่าน':'รอไฟล์';
  if($('assistantStatus'))$('assistantStatus').textContent='พร้อมอ่านสไลด์';
}
$('autoReadBtn').onclick=startReading;
$('stopReadBtn').onclick=stopReading;



function analyzeTranscript(text){
  const decisions=[],actions=[],pending=[];
  const rows=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  for(const row of rows){
    if(/ตกลง|อนุมัติ|เห็นด้วย|มีมติ|สรุปว่า|ตัดสินใจ/i.test(row))decisions.push(row);
    if(/ฉันจะ|ผมจะ|จะทำ|มอบหมาย|รับผิดชอบ|ประสาน|ส่งภายใน|ให้คุณ/i.test(row))actions.push(row);
    if(/ยังสรุปไม่ได้|รอ.*ยืนยัน|รอยืนยัน|ขอเช็ก|ยังไม่ได้ข้อสรุป|pending/i.test(row))pending.push(row);
  }
  return {decisions,actions,pending};
}

function fmt(ms){const s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return[h,m,ss].map(x=>String(x).padStart(2,'0')).join(':')}
function updateMeetingButtons(){const rec=state.meetingState==='recording',pause=state.meetingState==='paused';$('startMeetingBtn').disabled=rec||pause;$('pauseMeetingBtn').disabled=!rec;$('resumeMeetingBtn').disabled=!pause;$('endMeetingBtn').disabled=!(rec||pause)}
async function startMeeting(){
  if(!state.slide)toast('ยังไม่ได้แนบสไลด์ — สามารถเริ่มประชุมได้ แต่ Auto Slide จะยังไม่ทำงาน');
  try{const r=await fetch('/api/start-meeting',{method:'POST'});const d=await r.json();state.meetingId=d.id;state.meetingState='recording';state.startedAt=Date.now();state.audioChunks=[];$('meetingStatus').textContent='กำลังบันทึกการประชุมในเครื่อง';$('assistantStatus').textContent='กำลังอ่านและติดตามสไลด์';$('assistantLivePill').textContent='● LIVE';$('assistantLivePill').className='live-pill live';updateMeetingButtons();state.timerHandle=setInterval(()=>$('timer').textContent=fmt(Date.now()-state.startedAt),500);
    try{state.stream=await navigator.mediaDevices.getUserMedia({audio:true});const types=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];const mime=types.find(x=>MediaRecorder.isTypeSupported(x))||'';state.recorder=new MediaRecorder(state.stream,mime?{mimeType:mime}:undefined);state.recorder.ondataavailable=e=>{if(e.data&&e.data.size)state.audioChunks.push(e.data)};state.recorder.start(1000)}catch(e){$('meetingStatus').textContent='เริ่มประชุมแล้ว • ไม่ได้รับสิทธิ์ไมค์ แต่ยังบันทึก Transcript ได้'}
    if($('autoAdvanceToggle').checked&&activeDeck()?.auto!==false&&state.slide&&pageTotal()>1)startReading();
  }catch(e){toast('เริ่มประชุมไม่สำเร็จ')}
}
function pauseMeeting(){if(state.recorder?.state==='recording')state.recorder.pause();stopReading();state.meetingState='paused';$('meetingStatus').textContent='พักการประชุม';$('assistantStatus').textContent='พักการอ่านสไลด์ชั่วคราว';$('assistantLivePill').textContent='● PAUSED';$('assistantLivePill').className='live-pill paused';updateMeetingButtons()}
function resumeMeeting(){if(state.recorder?.state==='paused')state.recorder.resume();state.meetingState='recording';$('meetingStatus').textContent='กำลังบันทึกต่อ';$('assistantStatus').textContent='กลับมาอ่านสไลด์ต่อแล้ว';$('assistantLivePill').textContent='● LIVE';$('assistantLivePill').className='live-pill live';updateMeetingButtons();if($('autoAdvanceToggle').checked&&activeDeck()?.auto!==false&&state.slide&&(state.page<pageTotal()-1||activeDeck()?.loop))startReading()}
async function endMeeting(){
  if(!state.meetingId)return;stopReading();clearInterval(state.timerHandle);if(state.recorder&&state.recorder.state!=='inactive'){await new Promise(resolve=>{state.recorder.addEventListener('stop',resolve,{once:true});state.recorder.stop()})}if(state.stream)state.stream.getTracks().forEach(t=>t.stop());
  if(state.audioChunks.length){const type=state.audioChunks[0].type||'audio/webm';const blob=new Blob(state.audioChunks,{type});await fetch(`/api/save-recording?id=${encodeURIComponent(state.meetingId)}`,{method:'POST',headers:{'Content-Type':type},body:blob}).catch(()=>{})}
  const analysis=$('secretaryToggle').checked?analyzeTranscript($('transcript').value):{decisions:[],actions:[],pending:[]};
  const meeting={id:state.meetingId,title:$('meetingTitle').value||'การประชุม',started_at:new Date(state.startedAt).toISOString(),ended_at:new Date().toISOString(),slide_id:state.slide?.id||'',slide_name:state.slide?.name||'',transcript:$('transcript').value,decisions:analysis.decisions,actions:analysis.actions,pending:analysis.pending,news_script:''};
  await fetch(`/api/save-meeting?id=${encodeURIComponent(state.meetingId)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(meeting)});
  state.latestMeeting=meeting;state.meetingState='idle';$('meetingStatus').textContent='จบประชุมและบันทึกแล้ว';$('assistantStatus').textContent='จบการอ่านสไลด์แล้ว';$('assistantLivePill').textContent='● READY';$('assistantLivePill').className='live-pill';updateMeetingButtons();renderSummary(meeting);showView('summary');toast('สรุปประชุมพร้อมแล้ว');
}
$('startMeetingBtn').onclick=startMeeting;$('pauseMeetingBtn').onclick=pauseMeeting;$('resumeMeetingBtn').onclick=resumeMeeting;$('endMeetingBtn').onclick=endMeeting;updateMeetingButtons();

function renderSummary(m){
  if(!m){$('decisionBox').textContent='ยังไม่มีข้อมูล';$('actionBox').textContent='ยังไม่มีข้อมูล';$('pendingBox').textContent='ยังไม่มีข้อมูล';$('summaryTranscript').textContent='ยังไม่มี Transcript';$('summaryMeetingTitle').textContent='ยังไม่มีการประชุม';return}
  $('decisionBox').textContent=m.decisions?.length?m.decisions.map(x=>'• '+x).join('\n'):'ยังไม่มีข้อมูล';$('actionBox').textContent=m.actions?.length?m.actions.map(x=>'• '+x).join('\n'):'ยังไม่มีข้อมูล';$('pendingBox').textContent=m.pending?.length?m.pending.map(x=>'• '+x).join('\n'):'ยังไม่มีข้อมูล';$('summaryTranscript').textContent=m.transcript||'ยังไม่มี Transcript';$('summaryMeetingTitle').textContent=m.title||'การประชุม';
}

async function loadLibrary(){
  const box=$('slideLibrary');box.innerHTML='<div class="card">กำลังโหลด...</div>';try{const r=await fetch('/api/slides');const d=await r.json();if(!d.slides?.length){box.innerHTML='<div class="card">ยังไม่มีสไลด์ในคลัง</div>';return}box.innerHTML=d.slides.map(s=>`<div class="card library-item"><div class="thumb">${s.ext==='.pdf'?'📕':s.ext==='.pptx'?'📊':s.ext.match(/png|jpg|jpeg|webp/)?'🖼️':'📄'}</div><h3>${escapeHtml(s.name)}</h3><p>${formatBytes(s.size)} • ${s.page_count||1} หน้า/สไลด์</p><button data-slide="${s.id}">เปิดในห้องประชุม</button></div>`).join('');box.querySelectorAll('[data-slide]').forEach(b=>b.onclick=()=>openLibrarySlide(b.dataset.slide,d.slides))}catch(e){box.innerHTML='<div class="card">โหลดคลังไม่สำเร็จ</div>'}
}
function openLibrarySlide(id,list){const s=(list||[]).find(x=>x.id===id);if(!s)return;state.slide=s;state.page=0;const d=activeDeck();if(d){d.slide=s;saveDecks();renderDecks()}renderSlide();showView('meeting');toast('เปิดสไลด์จากคลังแล้ว')}

async function loadHistory(){
  const box=$('historyList');box.textContent='กำลังโหลด...';try{const r=await fetch('/api/history');const d=await r.json();if(!d.meetings?.length){box.textContent='ยังไม่มีประวัติ';return}box.innerHTML=d.meetings.map(m=>`<div class="history-row"><div><strong>${escapeHtml(m.title||'การประชุม')}</strong><small>${escapeHtml(m.started_at||'')}</small></div><button data-meeting="${escapeHtml(m.id||'')}">เปิด</button></div>`).join('');box.querySelectorAll('[data-meeting]').forEach(b=>b.onclick=()=>openMeeting(b.dataset.meeting))}catch(e){box.textContent='โหลดประวัติไม่สำเร็จ'}
}
async function openMeeting(id){const r=await fetch('/api/meeting?id='+encodeURIComponent(id));if(!r.ok)return toast('เปิดประชุมย้อนหลังไม่ได้');const m=await r.json();state.latestMeeting=m;renderSummary(m);showView('summary')}
$('refreshHistoryBtn').onclick=loadHistory;



function openDeckSettings(id){
  const d=state.decks.find(x=>x.id===id);if(!d)return;
  state.deckSettingsId=id;
  $('deckSettingName').value=d.name||'';
  $('deckSettingInterval').value=String(d.interval||5);
  $('deckSettingAuto').checked=d.auto!==false;
  $('deckSettingLoop').checked=!!d.loop;
  $('deckSettingsModal').classList.remove('hidden');
}
function closeDeckSettings(){
  state.deckSettingsId=null;
  $('deckSettingsModal').classList.add('hidden');
}
$('cancelDeckSettingsBtn').onclick=closeDeckSettings;
$('saveDeckSettingsBtn').onclick=()=>{
  const d=state.decks.find(x=>x.id===state.deckSettingsId);if(!d)return closeDeckSettings();
  d.name=$('deckSettingName').value.trim();
  d.interval=Number($('deckSettingInterval').value||5);
  d.auto=$('deckSettingAuto').checked;
  d.loop=$('deckSettingLoop').checked;
  saveDecks();renderDecks();closeDeckSettings();toast('บันทึกตั้งค่ากองแล้ว');
};


function populateSlideVoices(){
  if(!('speechSynthesis' in window))return;
  const sel=$('slideVoiceSelect');
  const saved=localStorage.getItem('meetcast_slide_voice_v18')||'';
  const voices=speechSynthesis.getVoices();
  sel.innerHTML='<option value="">อัตโนมัติ</option>'+voices.map(v=>
    `<option value="${escapeHtml(v.voiceURI||v.name)}">${escapeHtml(v.name)} — ${escapeHtml(v.lang)}</option>`
  ).join('');
  if(saved)sel.value=saved;
}
if('speechSynthesis' in window){
  populateSlideVoices();
  speechSynthesis.onvoiceschanged=populateSlideVoices;
}
$('slideVoiceSelect').onchange=()=>localStorage.setItem('meetcast_slide_voice_v18',$('slideVoiceSelect').value);
const savedClarityMode=localStorage.getItem('meetcast_voice_clarity_mode_v27')||'clear';
$('voiceClarityMode').value=savedClarityMode;
const savedVoiceRate=localStorage.getItem('meetcast_slide_voice_rate_v18')||'0.9';
$('slideVoiceRateSetting').value=savedVoiceRate;
const savedVoicePause=localStorage.getItem('meetcast_voice_pause_v27')||'140';
$('voicePauseSetting').value=savedVoicePause;

$('voiceClarityMode').onchange=()=>{
  const mode=$('voiceClarityMode').value;
  const rateMap={clear:'0.9',normal:'1',brief:'1.08'};
  localStorage.setItem('meetcast_voice_clarity_mode_v27',mode);
  $('slideVoiceRateSetting').value=rateMap[mode]||'0.9';
  localStorage.setItem('meetcast_slide_voice_rate_v18',$('slideVoiceRateSetting').value);
  $('voiceQualityStatus').textContent=mode==='clear'?'โหมดชัดเจน: อ่านช้าลงเล็กน้อยและเว้นจังหวะธรรมชาติ':mode==='brief'?'โหมดกระชับ: เร็วขึ้นเล็กน้อย':'โหมดปกติ';
};
$('slideVoiceRateSetting').onchange=()=>localStorage.setItem('meetcast_slide_voice_rate_v18',$('slideVoiceRateSetting').value);
$('voicePauseSetting').onchange=()=>localStorage.setItem('meetcast_voice_pause_v27',$('voicePauseSetting').value);

$('testSlideVoiceBtn').onclick=()=>{
  if(!('speechSynthesis' in window))return toast('เครื่องนี้ไม่พบระบบ Text-to-Speech');
  stopReading();
  state.reading=true;
  $('voiceQualityStatus').textContent='กำลังทดลองเสียง...';
  speakSlide('สวัสดีครับ นี่คือระบบ MeetCast AI เสียงอ่านแบบชัดเจน สำหรับการประชุมและการนำเสนอข้อมูล',()=>{
    state.reading=false;
    $('voiceQualityStatus').textContent='ทดลองเสียงเสร็จแล้ว';
    $('readStatus').textContent=state.slide?'พร้อมอ่าน':'รอไฟล์';
  });
};

function presenterSource(choice){
  if(choice==='female')return{type:'image',src:'presenter-female.svg'};
  if(choice==='male')return{type:'image',src:'presenter-male.svg'};
  if(choice==='custom'){
    const src=localStorage.getItem('meetcast_custom_presenter_v20')||'news-presenter.png';
    const type=localStorage.getItem('meetcast_custom_presenter_type_v20')||'image';
    return{type,src};
  }
  return{type:'image',src:'news-presenter.png'};
}
function applyPresenter(choice){
  const value=choice||'attached';
  localStorage.setItem('meetcast_presenter_v18',value);
  $('presenterSelect').value=value;
  const media=presenterSource(value);
  const img=$('assistantPortraitImg'),video=$('assistantPortraitVideo');
  if(media.type==='video'){
    img.classList.add('hidden');
    video.classList.remove('hidden');
    video.src=media.src;
    video.muted=true;
    video.loop=true;
    video.playsInline=true;
    video.play().catch(()=>{});
  }else{
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.classList.add('hidden');
    img.classList.remove('hidden');
    img.src=media.src;
  }
}
$('presenterSelect').onchange=()=>applyPresenter($('presenterSelect').value);
$('customPresenterBtn').onclick=()=>$('customPresenterInput').click();
$('customPresenterInput').onchange=e=>{
  const file=e.target.files?.[0];if(!file)return;
  const isVideo=file.type.startsWith('video/')||/\.(mp4|webm|mov)$/i.test(file.name);
  const isImage=file.type.startsWith('image/')||/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
  if(!isVideo&&!isImage)return toast('รองรับไฟล์ภาพหรือวิดีโอเท่านั้น');
  const maxBytes=isVideo?50*1024*1024:10*1024*1024;
  if(file.size>maxBytes)return toast(isVideo?'วิดีโอต้องไม่เกิน 50 MB':'รูปต้องไม่เกิน 10 MB');
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      localStorage.setItem('meetcast_custom_presenter_v20',String(reader.result||''));
      localStorage.setItem('meetcast_custom_presenter_type_v20',isVideo?'video':'image');
      applyPresenter('custom');
      toast(isVideo?'เปลี่ยนวิดีโอนักข่าวแล้ว':'เปลี่ยนรูปนักข่าวแล้ว');
    }catch(err){
      toast('ไฟล์ใหญ่เกินพื้นที่จัดเก็บในโปรแกรม');
    }
  };
  reader.readAsDataURL(file);
};
applyPresenter(localStorage.getItem('meetcast_presenter_v18')||'attached');


function applyTickerSettings(){const ticker=$('presenterTicker'),tickerText=$('presenterTickerText'),textInput=$('tickerTextSetting'),speedInput=$('tickerSpeedSetting'),toggle=$('tickerToggle');if(!ticker||!tickerText||!textInput||!speedInput||!toggle)return;const text=localStorage.getItem('meetcast_ticker_text_v21')||'MeetCast AI • พร้อมสำหรับการประชุมอัจฉริยะ';const speed=localStorage.getItem('meetcast_ticker_speed_v21')||'12';const enabled=localStorage.getItem('meetcast_ticker_enabled_v21')!=='false';textInput.value=text;speedInput.value=speed;toggle.checked=enabled;tickerText.textContent=text||' ';ticker.style.setProperty('--ticker-duration',`${speed}s`);ticker.classList.toggle('hidden',!enabled);tickerText.style.animation='none';void tickerText.offsetWidth;tickerText.style.animation='';}
$('tickerTextSetting').oninput=()=>{
  localStorage.setItem('meetcast_ticker_text_v21',$('tickerTextSetting').value);
  applyTickerSettings();
};
$('tickerSpeedSetting').onchange=()=>{
  localStorage.setItem('meetcast_ticker_speed_v21',$('tickerSpeedSetting').value);
  applyTickerSettings();
};
$('tickerToggle').onchange=()=>{
  localStorage.setItem('meetcast_ticker_enabled_v21',String($('tickerToggle').checked));
  applyTickerSettings();
};
applyTickerSettings();



const savedSlideInterval=localStorage.getItem('meetcast_slide_interval_v14')||'5';
$('slideIntervalSetting').value=savedSlideInterval;
$('slideIntervalSetting').onchange=()=>localStorage.setItem('meetcast_slide_interval_v14',$('slideIntervalSetting').value);

$('quitBtn').onclick=async()=>{if(confirm('ปิด MeetCast AI?')){await fetch('/api/quit',{method:'POST'}).catch(()=>{});document.body.innerHTML='<div style="font-family:Segoe UI;padding:60px;text-align:center"><h2>MeetCast AI ปิดแล้ว</h2><p>สามารถปิดหน้าต่างนี้ได้</p></div>'}};
setInterval(()=>fetch('/api/heartbeat').catch(()=>{}),15000);
try{loadDecks()}catch(e){console.warn('deck startup',e)}
try{loadLibrary()}catch(e){console.warn('library startup',e)}


// v1.2 — collapsible sidebar drawer
function openSidebar(){const side=$('sidebar'),overlay=$('sidebarOverlay'),btn=$('menuBtn');if(!side)return;side.classList.add('open');overlay?.classList.add('show');side.setAttribute('aria-hidden','false');overlay?.setAttribute('aria-hidden','false');btn?.setAttribute('aria-expanded','true');document.body.classList.add('sidebar-open');}
function closeSidebar(){const side=$('sidebar'),overlay=$('sidebarOverlay'),btn=$('menuBtn');if(!side)return;side.classList.remove('open');overlay?.classList.remove('show');side.setAttribute('aria-hidden','true');overlay?.setAttribute('aria-hidden','true');btn?.setAttribute('aria-expanded','false');document.body.classList.remove('sidebar-open');}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSidebar()});
