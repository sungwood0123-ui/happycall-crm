import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

const CALL_RESULTS = {
  '통화완료': ['불만사항없음', '불만사항있음'],
  '부재중': ['카카오톡발송', '문자발송'],
  '통화거부': ['통화거부']
};

function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('happycall_user');
    return saved ? JSON.parse(saved) : null;
  });

  if (!supabaseUrl || !supabaseAnonKey) return <EnvMissing />;
  if (!user) return <Login onLogin={setUser} />;

  return <MainApp user={user} onLogout={() => {
    localStorage.removeItem('happycall_user');
    setUser(null);
  }} />;
}

function EnvMissing() {
  return (
    <div className="page center">
      <div className="loginCard">
        <h1>세찬 해피콜 관리시스템</h1>
        <p className="error">Supabase 연결값이 설정되지 않았습니다.</p>
        <p className="muted">Vercel 환경변수에 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY를 넣어주세요.</p>
      </div>
    </div>
  );
}

function Login({ onLogin }) {
  const [employees, setEmployees] = useState([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { loadEmployees(); }, []);

  async function loadEmployees() {
    const { data, error } = await supabase.from('employees').select('*').eq('status', '재직').order('name');
    if (error) setErr(error.message);
    setEmployees(data || []);
  }

  function login() {
    setErr('');
    const emp = employees.find(e => e.name === name);
    if (!emp) return setErr('직원을 선택해주세요.');
    if ((emp.password || '') !== password) return setErr('비밀번호가 맞지 않습니다.');
    localStorage.setItem('happycall_user', JSON.stringify(emp));
    onLogin(emp);
  }

  return (
    <div className="page center">
      <div className="loginCard">
        <h1>세찬 해피콜 관리시스템</h1>
        <p className="subtitle">고객 관리 · 해피콜 · VOC 통합 시스템</p>
        <label>직원 선택</label>
        <select value={name} onChange={e => setName(e.target.value)}>
          <option value="">직원을 선택하세요</option>
          {employees.map(e => <option key={e.id} value={e.name}>{e.name} / {e.store_name} / {e.role || '직원'}</option>)}
        </select>
        <label>비밀번호</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if(e.key === 'Enter') login(); }} placeholder="비밀번호 입력" />
        {err && <p className="error">{err}</p>}
        <button className="primary" onClick={login}>로그인</button>
      </div>
    </div>
  );
}

function MainApp({ user, onLogout }) {
  const [tab, setTab] = useState(user.role === '직원' ? 'mycalls' : 'dashboard');
  const isAdmin = user.role === '관리자';
  const isChecker = user.role === '검수자' || user.role === '관리자';

  return (
    <div className="app">
      <header>
        <div>
          <h1>세찬 해피콜 관리시스템</h1>
          <p>{user.name} · {user.store_name} · {user.role || '직원'}</p>
        </div>
        <button onClick={onLogout}>로그아웃</button>
      </header>

      <nav>
        {(isAdmin || isChecker) && <button className={tab==='dashboard'?'active':''} onClick={()=>setTab('dashboard')}>대시보드</button>}
        <button className={tab==='mycalls'?'active':''} onClick={()=>setTab('mycalls')}>내 해피콜</button>
        {isAdmin && <button className={tab==='employees'?'active':''} onClick={()=>setTab('employees')}>직원관리</button>}
        {isAdmin && <button className={tab==='stores'?'active':''} onClick={()=>setTab('stores')}>매장관리</button>}
        {(isAdmin || isChecker) && <button className={tab==='allcalls'?'active':''} onClick={()=>setTab('allcalls')}>전체 해피콜</button>}
      </nav>

      <main>
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'mycalls' && <CallList user={user} mode="mine" />}
        {tab === 'allcalls' && <CallList user={user} mode="all" />}
        {tab === 'employees' && <Employees />}
        {tab === 'stores' && <Stores />}
      </main>
    </div>
  );
}

function Dashboard() {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);

  useEffect(() => { load(); }, []);

  async function load() {
    const { data: t } = await supabase.from('happycall_targets').select('*').eq('is_skipped', false);
    const { data: l } = await supabase.from('happycall_logs').select('*');
    setTargets(t || []);
    setLogs(l || []);
  }

  const loggedTargetIds = new Set(logs.map(l => l.target_id));
  const done = targets.filter(t => loggedTargetIds.has(t.id)).length;
  const pending = targets.length - done;
  const voc = logs.filter(l => l.call_detail === '불만사항있음').length;

  return (
    <div>
      <h2>대시보드</h2>
      <div className="stats">
        <Card title="전체 대상" value={targets.length} />
        <Card title="완료" value={done} />
        <Card title="미완료" value={pending} />
        <Card title="불만 있음" value={voc} />
      </div>
    </div>
  );
}

function Card({ title, value }) {
  return <div className="stat"><span>{title}</span><b>{value}</b></div>;
}

function CallList({ user, mode }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [selected, setSelected] = useState(null);

  useEffect(() => { load(); }, [mode]);

  async function load() {
    let q = supabase.from('happycall_targets').select('*').eq('is_skipped', false).order('target_date', { ascending: false });
    if (mode === 'mine') q = q.eq('assigned_employee', user.name);
    const { data: t, error } = await q;
    if (error) alert(error.message);
    setTargets(t || []);
    const { data: l } = await supabase.from('happycall_logs').select('*').order('checked_at', { ascending: false });
    setLogs(l || []);
  }

  const latestLogByTarget = useMemo(() => {
    const map = {};
    logs.forEach(l => { if (!map[l.target_id]) map[l.target_id] = l; });
    return map;
  }, [logs]);

  return (
    <div>
      <h2>{mode === 'mine' ? '내 해피콜 리스트' : '전체 해피콜 리스트'}</h2>
      <div className="list">
        {targets.map(t => {
          const log = latestLogByTarget[t.id];
          return (
            <div className="callItem" key={t.id} onClick={() => setSelected(t)}>
              <div>
                <b>{t.join_no}</b>
                <p>{t.assigned_store} · {t.assigned_employee} · {callTypeLabel(t.call_type)}</p>
                <p className="muted">대상일 {t.target_date} / {t.assign_reason || t.skip_reason || ''}</p>
              </div>
              <span className={log ? 'badge done' : 'badge'}>{log ? log.call_result : '미진행'}</span>
            </div>
          );
        })}
      </div>
      {selected && <CallModal target={selected} user={user} onClose={() => setSelected(null)} onSaved={load} />}
    </div>
  );
}

function callTypeLabel(type) {
  return ({
    MONTHLY_DAY: '월간 정기',
    D_PLUS_1: 'D+1',
    D_PLUS_7: 'D+7',
    D_PLUS_13: 'D+13',
    D_PLUS_95: 'D+95',
    D_PLUS_185: 'D+185'
  })[type] || type;
}

function CallModal({ target, user, onClose, onSaved }) {
  const [result, setResult] = useState('통화완료');
  const [detail, setDetail] = useState('불만사항없음');
  const [memo, setMemo] = useState('');
  const [history, setHistory] = useState([]);
  const [script, setScript] = useState(null);

  useEffect(() => { loadDetail(); }, [target.id]);

  async function loadDetail() {
    const { data: h } = await supabase.from('customers').select('*').eq('join_no', target.join_no).order('open_date', { ascending: false });
    setHistory(h || []);
    const { data: s } = await supabase.from('call_scripts').select('*').eq('call_type', target.call_type).maybeSingle();
    setScript(s);
  }

  function onResultChange(v) {
    setResult(v);
    setDetail(CALL_RESULTS[v][0]);
  }

  async function save() {
    if (detail === '불만사항있음' && !memo.trim()) {
      alert('불만 사항 있음은 메모가 필요합니다.');
      return;
    }
    const payload = {
      target_id: target.id,
      join_no: target.join_no,
      employee_name: user.name,
      call_result: result,
      call_detail: detail,
      memo,
      checked_by: user.name
    };
    const { error } = await supabase.from('happycall_logs').insert(payload);
    if (error) return alert(error.message);

    if (detail === '불만사항있음') {
      await supabase.from('voc_logs').insert({
        target_id: target.id,
        join_no: target.join_no,
        customer_issue: memo,
        status: '미처리'
      });
    }
    alert('저장되었습니다.');
    onSaved();
    onClose();
  }

  return (
    <div className="modalBg">
      <div className="modal">
        <div className="modalHead"><h2>해피콜 상세</h2><button onClick={onClose}>닫기</button></div>
        <section>
          <h3>고객 기본정보</h3>
          <div className="infoGrid">
            <p><b>가입번호</b><br />{target.join_no}</p>
            <p><b>대상일</b><br />{target.target_date}</p>
            <p><b>유형</b><br />{callTypeLabel(target.call_type)}</p>
            <p><b>담당자</b><br />{target.assigned_employee}</p>
          </div>
        </section>
        <section><h3>배정 사유</h3><p className="reason">{target.assign_reason || target.skip_reason || '배정 사유 없음'}</p></section>
        {script && <section><h3>연락 스크립트</h3><div className="script"><b>{script.title}</b><p>{script.script}</p></div></section>}
        <section>
          <h3>고객 개통 이력</h3>
          <div className="history">
            {history.length ? history.map(h => <div key={h.id}><b>{h.open_date}</b> · {h.store_name} · {h.seller_name}</div>) : <p className="muted">개통 이력이 없습니다.</p>}
          </div>
        </section>
        <section>
          <h3>통화 결과</h3>
          <select value={result} onChange={e => onResultChange(e.target.value)}>{Object.keys(CALL_RESULTS).map(v => <option key={v}>{v}</option>)}</select>
          <select value={detail} onChange={e => setDetail(e.target.value)}>{CALL_RESULTS[result].map(v => <option key={v}>{v}</option>)}</select>
          <textarea value={memo} onChange={e => setMemo(e.target.value)} placeholder="메모 입력" />
          <button className="primary" onClick={save}>저장</button>
        </section>
      </div>
    </div>
  );
}

function Employees() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name:'', store_name:'금촌', status:'재직', password:'1234', role:'직원' });
  useEffect(() => { load(); }, []);
  async function load() { const { data } = await supabase.from('employees').select('*').order('name'); setRows(data || []); }
  async function add() {
    if (!form.name.trim()) return alert('직원명을 입력해주세요.');
    const { error } = await supabase.from('employees').insert(form);
    if (error) return alert(error.message);
    setForm({ name:'', store_name:'금촌', status:'재직', password:'1234', role:'직원' });
    load();
  }
  async function update(id, patch) { const { error } = await supabase.from('employees').update(patch).eq('id', id); if (error) alert(error.message); load(); }
  return (
    <div>
      <h2>직원관리</h2>
      <div className="formGrid">
        <input placeholder="직원명" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />
        <input placeholder="소속매장" value={form.store_name} onChange={e=>setForm({...form,store_name:e.target.value})} />
        <select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option>재직</option><option>퇴사</option><option>리스트 제외</option></select>
        <input placeholder="비밀번호" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} />
        <select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}><option>직원</option><option>검수자</option><option>관리자</option></select>
        <button className="primary" onClick={add}>직원 추가</button>
      </div>
      <table><thead><tr><th>이름</th><th>매장</th><th>상태</th><th>비밀번호</th><th>권한</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id}>
          <td>{r.name}</td>
          <td><input value={r.store_name||''} onChange={e=>update(r.id,{store_name:e.target.value})} /></td>
          <td><select value={r.status||'재직'} onChange={e=>update(r.id,{status:e.target.value})}><option>재직</option><option>퇴사</option><option>리스트 제외</option></select></td>
          <td><input value={r.password||''} onChange={e=>update(r.id,{password:e.target.value})} /></td>
          <td><select value={r.role||'직원'} onChange={e=>update(r.id,{role:e.target.value})}><option>직원</option><option>검수자</option><option>관리자</option></select></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function Stores() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name:'', status:'운영중', successor_store:'' });
  useEffect(() => { load(); }, []);
  async function load() { const { data } = await supabase.from('stores').select('*').order('name'); setRows(data || []); }
  async function add() {
    if (!form.name.trim()) return alert('매장명을 입력해주세요.');
    const { error } = await supabase.from('stores').insert(form);
    if (error) return alert(error.message);
    setForm({ name:'', status:'운영중', successor_store:'' });
    load();
  }
  async function update(id, patch) { const { error } = await supabase.from('stores').update(patch).eq('id', id); if (error) alert(error.message); load(); }
  return (
    <div>
      <h2>매장관리</h2>
      <div className="formGrid">
        <input placeholder="매장명" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />
        <select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option>운영중</option><option>폐점</option></select>
        <input placeholder="승계매장" value={form.successor_store||''} onChange={e=>setForm({...form,successor_store:e.target.value})} />
        <button className="primary" onClick={add}>매장 추가</button>
      </div>
      <table><thead><tr><th>매장명</th><th>상태</th><th>승계매장</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id}>
          <td>{r.name}</td>
          <td><select value={r.status||'운영중'} onChange={e=>update(r.id,{status:e.target.value})}><option>운영중</option><option>폐점</option></select></td>
          <td><input value={r.successor_store||''} onChange={e=>update(r.id,{successor_store:e.target.value})} /></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
