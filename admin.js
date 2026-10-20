(() => {
  'use strict';
  const $ = (id) => document.getElementById(id); let current, user;
  const message = (text) => { $('message').textContent = text; };
  async function request(path, options = {}, scoped = true) {
    const target = scoped ? `${path}${path.includes('?')?'&':'?'}planet=${encodeURIComponent($('planet').value || 'default')}` : path;
    const response = await fetch(target, { ...options, signal: AbortSignal.timeout(15000), headers: { 'Content-Type':'application/json', ...($('token').value ? {'X-Admin-Token':$('token').value}:{}), ...options.headers } });
    if (!response.ok) { let body; try { body = await response.json(); } catch (_) {} throw new Error(body?.message || '请求失败'); }
    return response;
  }
  const data = async (...args) => (await request(...args)).json();
  const post = (path,value) => data(path,{method:'POST',body:JSON.stringify(value)});
  const action = (fn) => async () => { try { await fn(); } catch (error) { message(error.message); } };
  const canReview = () => user && ['owner','moderator'].includes(user.role);
  const cell = (row,text) => { const el=document.createElement('td');el.textContent=text;row.append(el);return el; };
  function renderWords() {
    if (!current) return; const query=$('search').value.toLowerCase();
    $('words').replaceChildren(...current.words.filter((w)=>w.word.toLowerCase().includes(query)&&(!$('hidden').checked||w.hidden)).map((w)=>{
      const row=document.createElement('tr');for(const text of [w.word,w.frequency,w.hidden?'已屏蔽':w.isSeed?'示例':'公开'])cell(row,text);
      const button=document.createElement('button');button.textContent=w.hidden?'恢复':'屏蔽';button.disabled=!canReview();
      button.onclick=action(async()=>{await data(`/api/admin/words/${encodeURIComponent(w.word)}${w.hidden?'/restore':''}`,{method:w.hidden?'POST':'DELETE'});await load();});cell(row,'').append(button);return row;
    }));
  }
  async function reviews() {
    const result=await data('/api/admin/reviews');$('reviews').replaceChildren(...result.items.map((r)=>{
      const row=document.createElement('tr');for(const text of [r.word,`${r.status}：${r.reason}`,r.createdAt])cell(row,text);
      const controls=cell(row,'');if(r.status==='pending')for(const [decision,label]of[['approved','通过'],['rejected','驳回']]){const button=document.createElement('button');button.textContent=label;button.disabled=!canReview();button.onclick=action(async()=>{await post(`/api/admin/reviews/${r.id}`,{decision});await load();});controls.append(button)}return row;
    }));
  }
  async function users() {
    if(user.role!=='owner')return;const result=await data('/api/admin/users',{},false);
    $('users').replaceChildren(...result.items.map((u)=>{
      const line=document.createElement('div');line.className='toolbar';const text=document.createElement('span');text.textContent=`${u.name} · ${u.role} · ${u.planets.join(',')} · ${u.disabled?'已禁用':'正常'}`;line.append(text);
      const role=document.createElement('select');for(const r of ['owner','moderator','viewer']){const option=document.createElement('option');option.value=r;option.textContent=r;role.append(option)}role.value=u.role;
      const scope=document.createElement('input');scope.value=u.planets.join(',');scope.setAttribute('aria-label',`${u.name} 房间范围`);
      const save=document.createElement('button');save.textContent='更新权限';save.onclick=action(async()=>{await post(`/api/admin/users/${u.id}`,{role:role.value,planets:scope.value.split(',').map(s=>s.trim()).filter(Boolean)});await users();message('权限已更新，旧会话已失效。');});
      const toggle=document.createElement('button');toggle.textContent=u.disabled?'启用':'禁用';toggle.onclick=action(async()=>{await post(`/api/admin/users/${u.id}`,{disabled:!u.disabled});await users();});line.append(role,scope,save,toggle);return line;
    }));
  }
  async function load() {
    const result=await data('/api/auth/me',{},false);user=result.user;$('userRole').textContent=`${user.name} / ${user.role}`;
    current=await data('/api/admin/export');$('summary').textContent=`${current.stats.wordCount} 个公开词 · ${current.stats.totalSubmissions} 次共鸣 · 今日 ${current.stats.todaySubmissions}（UTC） · ${current.stats.uniqueVisitors} 位独立访客`;
    $('name').value=current.planet.name;$('theme').value=current.planet.theme;$('reviewMode').checked=current.planet.reviewMode;
    $('view').href=`/?planet=${encodeURIComponent(current.planet.slug)}`;
    $('recent').textContent=JSON.stringify(current.submissions.slice(-100).reverse(),null,2);$('audit').textContent=JSON.stringify(current.moderation.slice(0,100),null,2);
    for(const id of ['settingsPanel','backupPanel','usersPanel'])$(id).hidden=user.role!=='owner';$('clear').disabled=user.role!=='owner';
    renderWords();await reviews();await users();const planets=await data('/api/admin/planets',{},false);$('planetList').replaceChildren(...planets.items.map(p=>{const e=document.createElement('option');e.value=p.slug;return e}));message('数据已从 SQLite 加载。');
  }
  function download(blob,name){const a=document.createElement('a'),href=URL.createObjectURL(blob);a.href=href;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}
  $('load').onclick=action(load);$('search').oninput=renderWords;$('hidden').onchange=renderWords;$('refreshReviews').onclick=action(reviews);
  $('login').onclick=action(async()=>{await data('/api/auth/login',{method:'POST',body:JSON.stringify({name:$('loginName').value,password:$('loginPassword').value})},false);$('token').value='';$('loginPassword').value='';await load();});
  $('logout').onclick=action(async()=>{await data('/api/auth/logout',{method:'POST'},false);$('token').value='';current=null;user=null;$('words').replaceChildren();$('reviews').replaceChildren();$('users').replaceChildren();$('recent').textContent='—';$('audit').textContent='—';$('userRole').textContent='';message('已退出。');});
  $('save').onclick=action(async()=>{await post('/api/admin/planet',{name:$('name').value,theme:$('theme').value,reviewMode:$('reviewMode').checked});await load();});
  $('clear').onclick=action(async()=>{if(confirm('屏蔽整颗星球？可逐条恢复。')){await post('/api/admin/clear',{});await load();}});
  $('export').onclick=action(async()=>{const v=await data('/api/admin/export');download(new Blob([JSON.stringify(v,null,2)],{type:'application/json'}),`inner-light-${v.planet.slug}.json`)});
  $('exportCSV').onclick=action(async()=>{const r=await request('/api/admin/export.csv');download(await r.blob(),`inner-light-${$('planet').value}.csv`)});
  $('import').onclick=action(async()=>{const f=$('importFile').files[0];if(!f)throw Error('请先选择文件。');if(f.size>5*1024*1024)throw Error('文件不能超过 5MB。');const text=await f.text();const format=f.name.toLowerCase().endsWith('.csv')?'csv':'json';await post('/api/admin/import',{format,mode:$('importMode').value,confirm:$('importConfirm').value,...(format==='csv'?{content:text}:{data:JSON.parse(text)})});await load();message('导入完成，数据已事务更新。');});
  $('createUser').onclick=action(async()=>{await post('/api/admin/users',{name:$('newName').value,password:$('newPassword').value,role:$('newRole').value,planets:$('newPlanets').value.split(',').map(s=>s.trim()).filter(Boolean)});$('newPassword').value='';await users();message('账户已创建。');});
})();
