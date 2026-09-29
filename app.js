const socket=io();
let me=null,current=null,currentKind=null,recording=null,recordChunks=[],selectedFile=null,ownerAuth=false;
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
function imgCompress(file,cb){const r=new FileReader();r.onload=e=>{const i=new Image();i.onload=()=>{const c=document.createElement("canvas"),max=500,scale=Math.min(1,max/Math.max(i.width,i.height));c.width=i.width*scale;c.height=i.height*scale;c.getContext("2d").drawImage(i,0,0,c.width,c.height);cb(c.toDataURL("image/jpeg",.75))};i.src=e.target.result};r.readAsDataURL(file)}
$("regFile").onchange=e=>{if(e.target.files[0])imgCompress(e.target.files[0],x=>$("regAvatar").src=x)};
$("loginBtn").onclick=()=>{const u=$("regUser").value.trim(),n=$("regNick").value.trim();if(!u||!n)return $("authError").textContent="Заповніть поля.";socket.emit("register",{username:u,nickname:n,avatar:$("regAvatar").src})};
socket.on("register_success",u=>{me=u;localStorage.setItem("webchat_username",u.username);localStorage.setItem("webchat_nickname",u.nickname);localStorage.setItem("webchat_avatar",u.avatar);showApp();refresh()});
socket.on("register_error",x=>$("authError").textContent=x);
socket.on("error_msg",x=>alert(x));
function showApp(){$("auth").classList.add("hidden");$("app").classList.remove("hidden");$("myAvatar").src=me.avatar||"https://i.imgur.com/6VBx3io.png";$("myNick").textContent=me.nickname;$("myUser").textContent=me.username}
function refresh(){socket.emit("get_chats");socket.emit("get_balance")}
socket.on("balance_update",x=>{if(me){Object.assign(me,x);$("myNick").innerHTML=esc(me.nickname)+(me.badge?` <span class="badge">${badgeEmoji(me.badge)}</span>`:"")}})
socket.on("chats_list",list=>{$("chats").innerHTML="";list.forEach(c=>addChat(c))});
function addChat(c){const d=document.createElement("div");d.className="chat";d.innerHTML=`<img src="${c.avatar||"https://i.imgur.com/6VBx3io.png"}"><div class="ct"><b>${esc(c.name)}</b> ${c.verified?'<span class="verified">✓</span>':""}<small>${esc(c.kind==="channel"?"Канал":"Груповий чат")}</small></div>`;d.onclick=()=>openRoom(c);$("chats").appendChild(d)}
function openRoom(c){current=c;currentKind="room";$("sidebar")?.classList?.add("mobile-hide");$("composer").classList.remove("hidden");$("feed").innerHTML="";$("headerInfo").innerHTML=`<b>${esc(c.name)}</b> ${c.verified?'<span class="verified">✓</span>':""}<small>${esc(c.description||"")}</small>`;socket.emit("open_chat",{chatId:c.id})}
socket.on("chat_opened",x=>{current=x.chat;$("feed").innerHTML="";if(x.chat.banner)$("feed").insertAdjacentHTML("beforeend",`<img class="banner" src="${x.chat.banner}">`);x.messages.forEach(renderRoomMessage);x.polls.forEach(p=>renderPoll(p));x.comments.forEach(renderComment);});
function renderRoomMessage(m){const d=document.createElement("div");d.className="bubble"+(m.sender===me.username?" me":"");d.id="m_"+m.id;d.innerHTML=`<b>${esc(m.sender)}</b><div>${esc(m.text)}</div>${fileHtml(m)}<div>${reactionsHtml(m.reactions)}</div><div class="meta">${new Date(m.created_at).toLocaleTimeString()} ${m.edited?"· ред.":""} ${m.pinned?"📌":""}</div><div class="actions">${m.sender===me.username?`<button onclick="editMessage('${m.id}')">✏️</button><button onclick="deleteMessage('${m.id}')">🗑️</button>`:""}<button onclick="react('${m.id}','❤️')">❤️</button><button onclick="react('${m.id}','👍')">👍</button><button onclick="pin('${m.id}')">📌</button><button onclick="comment('${m.id}')">💬</button></div>`;$("feed").appendChild(d)}
function fileHtml(m){if(!m.file_data)return"";if(m.file_type?.startsWith("image/"))return`<img src="${m.file_data}">`;if(m.file_type?.startsWith("video/"))return`<video src="${m.file_data}" controls></video>`;if(m.file_type?.startsWith("audio/"))return`<audio src="${m.file_data}" controls></audio>`;return`<a href="${m.file_data}" download="${esc(m.file_name||"file")}">📎 ${esc(m.file_name||"Файл")}</a>`}
function reactionsHtml(r){r=r||{};return Object.values(r).map(x=>`<span class="reaction">${esc(x)}</span>`).join("")}
$("send").onclick=send;$("msg").onkeydown=e=>{if(e.key==="Enter")send()};
$("attach").onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>selectedFile={data:ev.target.result,name:f.name,type:f.type};r.readAsDataURL(f)};
function send(){const t=$("msg").value.trim();if(!current||(!t&&!selectedFile))return;if(currentKind==="dm")socket.emit("send_direct_message",{recipient:current.username,text:t,fileData:selectedFile?.data,fileName:selectedFile?.name,fileType:selectedFile?.type});else socket.emit("send_chat_message",{chatId:current.id,text:t,fileData:selectedFile?.data,fileName:selectedFile?.name,fileType:selectedFile?.type});$("msg").value="";selectedFile=null;$("attach").value=""}
$("voice").onclick=async()=>{if(recording){recording.stop();return}try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});recordChunks=[];recording=new MediaRecorder(stream);recording.ondataavailable=e=>recordChunks.push(e.data);recording.onstop=()=>{const blob=new Blob(recordChunks,{type:"audio/webm"}),r=new FileReader();r.onload=()=>{if(current)socket.emit(currentKind==="dm"?"send_direct_message":"send_chat_message",currentKind==="dm"?{recipient:current.username,text:"🎙️ Голосове",fileData:r.result,fileName:"voice.webm",fileType:"audio/webm"}:{chatId:current.id,text:"🎙️ Голосове",fileData:r.result,fileName:"voice.webm",fileType:"audio/webm"});stream.getTracks().forEach(t=>t.stop());recording=null};r.readAsDataURL(blob)};recording.start()}catch(e){alert("Немає доступу до мікрофона.")}};
socket.on("chat_new_message",m=>{if(current?.id===m.chat_id){renderRoomMessage(m);$("feed").scrollTop=$("feed").scrollHeight}});
socket.on("direct_history",ms=>{currentKind="dm";$("feed").innerHTML="";ms.forEach(renderDM)});
socket.on("new_direct_message",m=>{if(currentKind==="dm"&&current?.username&&(m.sender===current.username||m.recipient===current.username))renderDM(m);});
function renderDM(m){const d=document.createElement("div");d.className="bubble"+(m.sender===me.username?" me":"");d.id="m_"+m.id;d.innerHTML=`<div>${esc(m.text)}</div>${fileHtml(m)}<div>${reactionsHtml(m.reactions)}</div><div class="meta">${new Date(m.created_at).toLocaleTimeString()} ${m.edited?"· ред.":""}</div><div class="actions">${m.sender===me.username?`<button onclick="editMessage('${m.id}')">✏️</button><button onclick="deleteMessage('${m.id}')">🗑️</button>`:""}<button onclick="react('${m.id}','❤️')">❤️</button><button onclick="pin('${m.id}')">📌</button></div>`;$("feed").appendChild(d)}
window.react=(id,e)=>socket.emit("add_reaction",{id,emoji:e});
window.editMessage=id=>{const t=prompt("Новий текст:");if(t!==null)socket.emit("edit_message",{id,newText:t})};
window.deleteMessage=id=>{if(confirm("Видалити повідомлення?"))socket.emit("delete_message",{id})};
window.pin=id=>socket.emit("pin_message",{id});
window.comment=id=>{const t=prompt("Коментар:");if(t)socket.emit("add_comment",{messageId:id,text:t})};
socket.on("message_updated",m=>{const e=$("m_"+m.id);if(!e)return;const text=e.querySelector("div");if(text&&m.text)text.textContent=m.text;e.querySelector(".meta").textContent=new Date(m.created_at).toLocaleTimeString()+" · ред.";});
socket.on("message_deleted",d=>$("m_"+d.id)?.remove());
socket.on("poll_created",x=>renderPoll(x.poll));socket.on("poll_updated",p=>{document.querySelector(`[data-poll="${p.id}"]`)?.replaceWith(pollEl(p))});
function renderPoll(p){$("feed").appendChild(pollEl(p))}
function pollEl(p){const d=document.createElement("div");d.className="poll";d.dataset.poll=p.id;const votes=p.votes||{};d.innerHTML=`<b>📊 ${esc(p.question)}</b>`+(p.options||[]).map(o=>`<button onclick="vote('${p.id}','${esc(o)}')">${esc(o)} · ${Object.values(votes).filter(v=>v===o).length}</button>`).join("");return d}
window.vote=(id,o)=>socket.emit("vote_poll",{pollId:id,option:o});
function renderComment(c){const d=document.createElement("div");d.className="bubble";d.innerHTML=`💬 <b>${esc(c.sender)}</b>: ${esc(c.text)}`;$("feed").appendChild(d)}
socket.on("comment_added",renderComment);

$("searchBtn").onclick=()=>socket.emit("search_user",$("search").value.trim());
socket.on("user_found",u=>{$("searchResult").innerHTML=`<div class="result"><b>${esc(u.nickname)}</b> ${esc(u.username)}<br><small>${esc(u.description||"")}</small></div>`;$("searchResult").onclick=()=>{current=u;currentKind="dm";$("composer").classList.remove("hidden");$("headerInfo").textContent=u.nickname+" "+u.username;$("feed").innerHTML="";socket.emit("get_direct_messages",{username:u.username})}});
socket.on("chat_found",c=>{$("searchResult").innerHTML=`<div class="result"><b>${esc(c.name)}</b> ${c.verified?"✓":""}<br><small>${esc(c.description||"")}</small><button onclick="joinFound('${c.id}')">Приєднатися</button></div>`});
window.joinFound=id=>socket.emit("join_chat",{chatId:id});

$("profileBtn").onclick=()=>openProfile();
function openProfile(){socket.emit("get_profile",{username:me.username});}
socket.on("profile_data",p=>{$("modal").classList.remove("hidden");$("modalContent").innerHTML=`<h2>Профіль</h2><div class="form"><img class="avatar-picker img" style="width:100px;height:100px" src="${p.avatar}"><input id="pn" value="${esc(p.nickname)}"><input id="pu" value="${esc(p.username)}"><textarea id="pd" placeholder="Опис профілю">${esc(p.description||"")}</textarea><button onclick="saveProfile()">Зберегти</button><p>💎 ${p.crystals} кристалів</p><button onclick="closeModal()">Закрити</button></div>`});
window.saveProfile=()=>{socket.emit("update_profile",{newUsername:$("pu").value,nickname:$("pn").value,description:$("pd").value,avatar:me.avatar})};
socket.on("profile_updated",u=>{me=u;showApp();closeModal();refresh()});

window.openCreate=kind=>{$("modal").classList.remove("hidden");$("modalContent").innerHTML=`<h2>${kind==="channel"?"Створити канал":"Створити груповий чат"}</h2><div class="form"><input id="cn" placeholder="Назва"><input id="ca" placeholder="URL аватарки (необов'язково)"><textarea id="cd" placeholder="Опис (необов'язково)"></textarea><input id="cb" placeholder="URL банера (необов'язково)">${kind==="group"?'<input id="cm" placeholder="Учасники через кому, @user1,@user2">':""}<button onclick="createNow('${kind}')">Створити</button><button onclick="closeModal()">Скасувати</button></div>`};
window.createNow=kind=>{const d={name:$("cn").value,avatar:$("ca").value,description:$("cd").value,banner:$("cb").value};if(kind==="channel")socket.emit("create_channel",d);else{d.members=$("cm").value.split(",").map(x=>x.trim()).filter(Boolean);socket.emit("create_chat",d)}};
socket.on("chat_created",c=>{closeModal();addChat(c);alert("Створено!")});
window.openShop=()=>{socket.emit("shop_catalog");$("modal").classList.remove("hidden");$("modalContent").innerHTML="<h2>💎 Магазин</h2><div id='shop' class='grid'></div><hr><h3>Промокод</h3><div class='form'><input id='promoCode' placeholder='Код'><button onclick=\"socket.emit('redeem_promo',{code:$('promoCode').value})\">Активувати</button><button onclick='createPromo()'>Створити промокод</button></div><button onclick='closeModal()'>Закрити</button>"};
socket.on("shop_catalog",x=>{const s=$("shop");if(!s)return;s.innerHTML="";x.frames.forEach(i=>s.innerHTML+=`<div class="shopitem"><div class="frame-preview" style="border-image:${i[2]} 1"></div><b>${i[1]}</b><p>💎 ${i[3]}</p><button onclick="buy('frame','${i[0]}')">Купити</button></div>`);x.badges.forEach(i=>s.innerHTML+=`<div class="shopitem"><div style="font-size:40px">${i[1]}</div><b>${i[2]}</b><p>💎 ${i[3]}</p><button onclick="buy('badge','${i[0]}')">Купити</button></div>`)});
window.buy=(type,id)=>socket.emit("buy_item",{type,id});
function createPromo(){$("modalContent").innerHTML=`<h2>Створити промокод</h2><div class="form"><input id="pc" placeholder="Код"><input id="pr" type="number" placeholder="Кристалів за активацію"><input id="pa" type="number" placeholder="Кількість активацій"><button onclick="socket.emit('create_promo',{code:$('pc').value,reward:+$('pr').value,activations:+$('pa').value})">Створити</button><button onclick='openShop()'>Назад</button></div>`}
$("headerMore").onclick=()=>{if(!current)return;const isOwner=current.owner===me.username;$("modal").classList.remove("hidden");$("modalContent").innerHTML=`<h2>${esc(current.name||current.nickname)}</h2><div class="form">${current.id?`<button onclick="editRoom()">✏️ Редагувати</button><button onclick="leaveRoom()">🚪 Покинути</button>${isOwner?`<button onclick="deleteRoom()">🗑️ Видалити</button>`:""}`:""}<button onclick='closeModal()'>Закрити</button></div>`};
window.editRoom=()=>{$("modalContent").innerHTML=`<h2>Редагувати</h2><div class="form"><input id="en" value="${esc(current.name)}"><input id="ea" value="${esc(current.avatar||"")}"><textarea id="ed">${esc(current.description||"")}</textarea><input id="eb" value="${esc(current.banner||"")}"><button onclick="socket.emit('edit_chat',{chatId:'${current.id}',name:$('en').value,avatar:$('ea').value,description:$('ed').value,banner:$('eb').value)">Зберегти</button></div>`};
window.leaveRoom=()=>socket.emit("leave_chat",{chatId:current.id});
window.deleteRoom=()=>{if(confirm("Видалити?"))socket.emit("delete_chat",{chatId:current.id})};
socket.on("chat_deleted",id=>{if(current?.id===id){current=null;$("feed").innerHTML="";$("composer").classList.add("hidden")}refresh();closeModal()});
socket.on("left_chat",()=>{closeModal();current=null;$("feed").innerHTML="";$("composer").classList.add("hidden");refresh()});
socket.on("chat_updated",c=>{current=c;$("headerInfo").innerHTML=`<b>${esc(c.name)}</b> ${c.verified?"✓":""}`;closeModal();refresh()});
$("back").onclick=()=>{$("sidebar").classList.remove("mobile-hide")};
$("modal").onclick=e=>{if(e.target.id==="modal")closeModal()};window.closeModal=()=>$("modal").classList.add("hidden");
function badgeEmoji(id){return ({crystals:"💎",webchat:"💬",donater:"💰",creator:"✨",verified:"✓",star:"⭐",crown:"👑"})[id]||""}

socket.on("connect",()=>{const u=localStorage.getItem("webchat_username");if(u)socket.emit("register",{username:u,nickname:localStorage.getItem("webchat_nickname")||"Користувач",avatar:localStorage.getItem("webchat_avatar")||"https://i.imgur.com/6VBx3io.png"})});

// Власницька панель: відкривається подвійним кліком по назві WebChat у профілі.
document.querySelector(".auth-card h1").ondblclick=()=>{
 $("modal").classList.remove("hidden");$("modalContent").innerHTML=`<h2>🛡️ Панель власника</h2><div class="form"><input id="op" type="password" placeholder="Пароль власника"><input id="ou" placeholder="@користувач для ∞ кристалів"><button onclick="ownerLogin()">Увійти</button><div id="ownerTools"></div><button onclick="closeModal()">Закрити</button></div>`;
};
window.ownerLogin=()=>{socket.emit("owner_login",{password:$("op").value});window.ownerPass=$("op").value};
socket.on("owner_auth",x=>{if(!x.ok)return alert("Невірний пароль");$("ownerTools").innerHTML=`<button onclick="socket.emit('owner_balance',{password:ownerPass,username:$('ou').value})">💎 Дати ∞ кристалів</button><hr><input id="oc" placeholder="ID каналу"><button onclick="socket.emit('owner_verify_channel',{password:ownerPass,chatId:$('oc').value,verified:true})">✓ Видати галочку</button><button onclick="socket.emit('owner_verify_channel',{password:ownerPass,chatId:$('oc').value,verified:false})">Зняти галочку</button><button onclick="socket.emit('owner_delete_channel',{password:ownerPass,chatId:$('oc').value})">🗑️ Видалити канал</button>`});
