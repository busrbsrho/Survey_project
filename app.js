// ─────────────────────────────────────────────────────────────
//  SurveyTrack — app.js
//  Firestore collections:
//    weeks/{id}                        → { name, order, createdAt }
//    weeks/{id}/surveys/{id}           → { name, url, date, createdAt }
//    students/{name}                   → { pass, createdAt }
//    completions/{name}/done/{survId}  → { done, at }
//    subjects/{id}                     → { name, createdAt }
//    grades/{studentName}/scores/{subjectId} → { grade, at }
//    assignments/{id}                  → { name, dueDate, dueSort, link, instructions, order, importedAt }
// ─────────────────────────────────────────────────────────────

import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore,
         collection, doc,
         getDocs, getDoc,
         setDoc, addDoc,
         updateDoc, deleteDoc,
         query, orderBy }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, INSTRUCTOR_CREDS, GRADES_CREDS } from "./firebase-config.js";

// ── Firebase ─────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ── Session ──────────────────────────────────────────────────
let currentUser = sessionStorage.getItem("st_user") || null;
let currentRole = sessionStorage.getItem("st_role") || null;

function saveSession(user, role) {
  currentUser = user; currentRole = role;
  sessionStorage.setItem("st_user", user);
  sessionStorage.setItem("st_role", role);
}
function clearSession() {
  currentUser = null; currentRole = null;
  sessionStorage.removeItem("st_user");
  sessionStorage.removeItem("st_role");
}

// ── Cache ─────────────────────────────────────────────────────
let weeksCache       = [];
let studentsCache    = [];
let completionsCache = {};   // { name: Set(surveyId) }
let subjectsCache    = [];   // [{ id, name }]
let assignmentsCache = [];   // [{ id, name, dueDate, dueSort, link, instructions }]

// ── UI state ──────────────────────────────────────────────────
let expandedWeeks = {};
let quickAddWeeks = {};
let editingEntry  = null;

// ── Helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function setErr(id,msg){ const e=$(id); if(e) e.textContent=msg; }
function clrErr(id)    { setErr(id,""); }
function loading(on)   { $("loading-overlay").style.display=on?"flex":"none"; }

// ── Date helpers ──────────────────────────────────────────────
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
function formatDate(ds) {
  if (!ds) return "No date";
  const [y,m,d] = ds.split("-").map(Number);
  const dt = new Date(y,m-1,d);
  return `${String(d).padStart(2,"0")}/${String(m).padStart(2,"0")}/${String(y).slice(2)} ${DAY_NAMES[dt.getDay()]}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ── Screen routing ────────────────────────────────────────────
window.showScreen = id => {
  document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
  $(id)?.classList.add("active");
};

function updateTopbar(role, name) {
  $("topbar-sub").textContent = name;
  $("role-badge").textContent = role;
  $("role-badge").hidden = false;
}

window.signOut = () => {
  clearSession();
  $("role-badge").hidden = true;
  $("topbar-sub").textContent = "Sign in to continue";
  ["ins-user","ins-pass","grd-user","grd-pass",
   "slogin-name","slogin-pass","signup-name","signup-pass"]
    .forEach(id=>{ const e=$(id); if(e) e.value=""; });
  ["ins-err","grd-err","slogin-err","signup-err"].forEach(clrErr);
  showScreen("screen-pick");
};

// ── Data fetch ────────────────────────────────────────────────
async function refreshAll() {
  // Weeks + surveys
  const wSnap = await getDocs(query(collection(db,"weeks"), orderBy("order","asc")));
  const weeks = [];
  for (const wDoc of wSnap.docs) {
    const ss = await getDocs(query(collection(db,"weeks",wDoc.id,"surveys"), orderBy("createdAt","asc")));
    weeks.push({ id:wDoc.id, name:wDoc.data().name, order:wDoc.data().order,
                 surveys: ss.docs.map(s=>({id:s.id,...s.data()})) });
  }
  weeksCache = weeks;

  // Subjects
  const subSnap = await getDocs(query(collection(db,"subjects"), orderBy("createdAt","asc")));
  subjectsCache = subSnap.docs.map(d=>({id:d.id,...d.data()}));

  // Assignments
  const assSnap = await getDocs(query(collection(db,"assignments"), orderBy("order","asc")));
  assignmentsCache = assSnap.docs.map(d=>({id:d.id,...d.data()}));

  // Students + completions (only needed for instructors)
  if (currentRole === "instructor" || currentRole === "grades") {
    const stSnap = await getDocs(collection(db,"students"));
    studentsCache = stSnap.docs.map(d=>d.id);
    completionsCache = {};
    await Promise.all(studentsCache.map(async name => {
      try {
        const cs = await getDocs(collection(db,"completions",name,"done"));
        completionsCache[name] = new Set(cs.docs.map(d=>d.id));
      } catch { completionsCache[name] = new Set(); }
    }));
  }

  // Re-render
  if (currentRole === "instructor") renderInstructorWeeks();
  if (currentRole === "grades")     { renderSubjects(); renderGradesAssignments(); }
  if (currentRole === "student")    { renderStudentAssignments(); renderStudentView(); }
}

// ── AUTH: Surveys instructor ──────────────────────────────────
window.instructorLogin = async () => {
  clrErr("ins-err");
  if ($("ins-user").value.trim()===INSTRUCTOR_CREDS.user &&
      $("ins-pass").value       ===INSTRUCTOR_CREDS.pass) {
    saveSession("instructor","instructor");
    updateTopbar("Surveys Instructor","Instructor");
    await refreshAll();
    renderInstructorWeeks();
    showScreen("screen-instructor");
  } else { setErr("ins-err","Incorrect credentials."); }
};

// ── AUTH: Grades instructor ───────────────────────────────────
window.gradesLogin = async () => {
  clrErr("grd-err");
  if ($("grd-user").value.trim()===GRADES_CREDS.user &&
      $("grd-pass").value       ===GRADES_CREDS.pass) {
    saveSession("grades","grades");
    updateTopbar("Grades Instructor","Grades Instructor");
    await refreshAll();
    renderSubjects();
    showScreen("screen-grades");
  } else { setErr("grd-err","Incorrect credentials."); }
};

// ── AUTH: Student ─────────────────────────────────────────────
window.studentSignup = async () => {
  clrErr("signup-err");
  const name = $("signup-name").value.trim();
  const pass = $("signup-pass").value;
  if (!name)           return setErr("signup-err","Please enter your full name.");
  if (pass.length < 4) return setErr("signup-err","Password must be at least 4 characters.");
  loading(true);
  try {
    const ref = doc(db,"students",name);
    if ((await getDoc(ref)).exists()) return setErr("signup-err","Name already registered.");
    await setDoc(ref,{pass,createdAt:Date.now()});
    saveSession(name,"student");
    updateTopbar("Student",name);
    await refreshAll();
    renderStudentAssignments();
    showScreen("screen-student");
  } catch(e) { setErr("signup-err","Error: "+e.message); }
  loading(false);
};

window.studentLogin = async () => {
  clrErr("slogin-err");
  const name = $("slogin-name").value.trim();
  const pass = $("slogin-pass").value;
  loading(true);
  try {
    const snap = await getDoc(doc(db,"students",name));
    if (!snap.exists()||snap.data().pass!==pass)
      return setErr("slogin-err","Name or password is incorrect.");
    saveSession(name,"student");
    updateTopbar("Student",name);
    await refreshAll();
    renderStudentAssignments();
    showScreen("screen-student");
  } catch(e) { setErr("slogin-err","Error: "+e.message); }
  loading(false);
};

// ── INSTRUCTOR TABS ───────────────────────────────────────────
window.switchTab = tab => {
  const surveys = tab==="surveys";
  const students = tab==="students";
  $("tab-surveys").hidden = !surveys;
  $("tab-students").hidden = !students;
  $("tab-btn-surveys").classList.toggle("active",surveys);
  $("tab-btn-surveys").setAttribute("aria-selected",String(surveys));
  $("tab-btn-students").classList.toggle("active",students);
  $("tab-btn-students").setAttribute("aria-selected",String(students));
  if (students) renderStudentsTab();
};

// ── GRADES TABS ───────────────────────────────────────────────
window.switchGradesTab = tab => {
  const subjects = tab==="subjects";
  const overview = tab==="overview";
  const assignments = tab==="assignments";
  $("gtab-subjects").hidden = !subjects;
  $("gtab-overview").hidden = !overview;
  $("gtab-assignments").hidden = !assignments;
  $("gtab-btn-subjects").classList.toggle("active",subjects);
  $("gtab-btn-subjects").setAttribute("aria-selected",String(subjects));
  $("gtab-btn-overview").classList.toggle("active",overview);
  $("gtab-btn-overview").setAttribute("aria-selected",String(overview));
  $("gtab-btn-assignments").classList.toggle("active",assignments);
  $("gtab-btn-assignments").setAttribute("aria-selected",String(assignments));
  if (overview) renderGradesOverview();
  if (assignments) renderGradesAssignments();
};

// ── STUDENT TABS ──────────────────────────────────────────────
window.switchStudentTab = tab => {
  const assignments = tab==="assignments";
  const surveys = tab==="surveys";
  const grades = tab==="grades";
  $("stab-assignments").hidden = !assignments;
  $("stab-surveys").hidden = !surveys;
  $("stab-grades").hidden = !grades;
  $("stab-btn-assignments").classList.toggle("active",assignments);
  $("stab-btn-assignments").setAttribute("aria-selected",String(assignments));
  $("stab-btn-surveys").classList.toggle("active",surveys);
  $("stab-btn-surveys").setAttribute("aria-selected",String(surveys));
  $("stab-btn-grades").classList.toggle("active",grades);
  $("stab-btn-grades").setAttribute("aria-selected",String(grades));
  if (assignments) renderStudentAssignments();
  if (surveys) renderStudentView();
  if (grades) renderStudentGrades();
};

// ── ADD WEEK ──────────────────────────────────────────────────
window.toggleAddWeek = () => {
  const f=$("add-week-form"); f.hidden=!f.hidden;
  if (!f.hidden){ clrErr("new-week-err"); $("new-week-name").focus(); $("new-survey-date").value=todayISO(); }
};
window.addWeek = async () => {
  clrErr("new-week-err");
  const wn=$("new-week-name").value.trim(), sn=$("new-survey-name").value.trim(),
        su=$("new-survey-url").value.trim(), sd=$("new-survey-date").value;
  if (!wn) return setErr("new-week-err","Please enter a week name.");
  if (!sn) return setErr("new-week-err","Please enter the survey name.");
  if (!su) return setErr("new-week-err","Please enter the survey URL.");
  if (!sd) return setErr("new-week-err","Please pick a date.");
  loading(true);
  try {
    const wRef = await addDoc(collection(db,"weeks"),{name:wn,order:Date.now(),createdAt:Date.now()});
    await addDoc(collection(db,"weeks",wRef.id,"surveys"),{name:sn,url:su,date:sd,createdAt:Date.now()});
    ["new-week-name","new-survey-name","new-survey-url","new-survey-date"].forEach(id=>{$(id).value="";});
    $("add-week-form").hidden=true;
    await refreshAll();
  } catch(e){ setErr("new-week-err","Error: "+e.message); }
  loading(false);
};

// ── QUICK ADD SURVEY ──────────────────────────────────────────
window.toggleQuickAdd = weekId => {
  quickAddWeeks[weekId]=!quickAddWeeks[weekId];
  renderInstructorWeeks();
  if (quickAddWeeks[weekId]) setTimeout(()=>{
    $("qs-name-"+weekId)?.focus();
    const de=$("qs-date-"+weekId); if(de&&!de.value) de.value=todayISO();
  },50);
};
window.addSurveyToWeek = async weekId => {
  const errId="qs-err-"+weekId; clrErr(errId);
  const sn=$("qs-name-"+weekId)?.value.trim(),
        su=$("qs-url-" +weekId)?.value.trim(),
        sd=$("qs-date-"+weekId)?.value;
  if (!sn||!su) return setErr(errId,"Please fill in name and URL.");
  if (!sd)      return setErr(errId,"Please pick a date.");
  loading(true);
  try {
    await addDoc(collection(db,"weeks",weekId,"surveys"),{name:sn,url:su,date:sd,createdAt:Date.now()});
    quickAddWeeks[weekId]=false;
    await refreshAll();
  } catch(e){ setErr(errId,"Error: "+e.message); }
  loading(false);
};

// ── DELETE WEEK / SURVEY ──────────────────────────────────────
window.deleteWeek = async (weekId,weekName) => {
  if (!confirm(`Delete "${weekName}" and all its surveys?`)) return;
  loading(true);
  try {
    const ss=await getDocs(collection(db,"weeks",weekId,"surveys"));
    for (const s of ss.docs) await deleteDoc(s.ref);
    await deleteDoc(doc(db,"weeks",weekId));
    delete expandedWeeks[weekId]; delete quickAddWeeks[weekId];
    await refreshAll();
  } catch(e){ alert("Error: "+e.message); }
  loading(false);
};
window.deleteSurvey = async (weekId,surveyId) => {
  loading(true);
  try { await deleteDoc(doc(db,"weeks",weekId,"surveys",surveyId)); await refreshAll(); }
  catch(e){ alert("Error: "+e.message); }
  loading(false);
};

// ── EDIT SURVEY ───────────────────────────────────────────────
window.startEditSurvey = (weekId,surveyId) => {
  editingEntry={weekId,surveyId}; renderInstructorWeeks();
  setTimeout(()=>$("edit-name-"+surveyId)?.focus(),50);
};
window.cancelEdit = () => { editingEntry=null; renderInstructorWeeks(); };
window.saveEditSurvey = async (weekId,surveyId) => {
  const n=$("edit-name-"+surveyId)?.value.trim(),
        u=$("edit-url-" +surveyId)?.value.trim(),
        d=$("edit-date-"+surveyId)?.value;
  if (!n||!u||!d) return;
  loading(true);
  try {
    await updateDoc(doc(db,"weeks",weekId,"surveys",surveyId),{name:n,url:u,date:d});
    editingEntry=null; await refreshAll();
  } catch(e){ alert("Error: "+e.message); }
  loading(false);
};

// ── PENDING TOGGLE ────────────────────────────────────────────
window.togglePending = id => {
  const p=document.getElementById("pending-"+id);
  if(p) p.hidden=!p.hidden;
};

// ── GROUP BY DATE ─────────────────────────────────────────────
function groupByDate(surveys) {
  const map={};
  for (const s of surveys){ const k=s.date||"no-date"; if(!map[k]) map[k]=[]; map[k].push(s); }
  return Object.entries(map).sort(([a],[b])=>{
    if(a==="no-date") return 1; if(b==="no-date") return -1; return a<b?-1:1;
  });
}

// ── RENDER: instructor weeks ──────────────────────────────────
function renderInstructorWeeks() {
  const c=$("instructor-weeks");
  if (!weeksCache.length){ c.innerHTML='<div class="empty">No weeks yet. Click "Add week" to get started.</div>'; return; }
  c.innerHTML=weeksCache.map(week=>{
    const collapsed=expandedWeeks[week.id]===false;
    const showQA=quickAddWeeks[week.id];
    const byDate=groupByDate(week.surveys);
    const datesHtml=byDate.length===0
      ? '<div class="empty" style="padding:6px 0">No surveys yet.</div>'
      : byDate.map(([dateKey,surveys])=>{
          const surveysHtml=surveys.map(s=>{
            if (editingEntry?.weekId===week.id&&editingEntry?.surveyId===s.id) {
              return `<div class="survey-row">
                <div class="edit-row-inputs">
                  <input id="edit-name-${esc(s.id)}" type="text" value="${esc(s.name)}" placeholder="Survey name"/>
                  <input id="edit-url-${esc(s.id)}"  type="url"  value="${esc(s.url)}"  placeholder="https://..."/>
                  <input id="edit-date-${esc(s.id)}" type="date" value="${esc(s.date||"")}"/>
                </div>
                <button class="btn btn-primary btn-sm" onclick="saveEditSurvey('${esc(week.id)}','${esc(s.id)}')">Save</button>
                <button class="btn btn-ghost btn-sm"   onclick="cancelEdit()">Cancel</button>
              </div>`;
            }
            const pending=studentsCache.filter(n=>!completionsCache[n]?.has(s.id));
            const allDone=studentsCache.length>0&&pending.length===0;
            const pendingHtml=allDone
              ? `<div class="pending-all-done"><i class="ti ti-circle-check"></i> All students answered</div>`
              : pending.map(name=>{
                  const ini=name.split(" ").map(x=>x[0]).join("").toUpperCase().slice(0,2);
                  return `<div class="pending-student"><div class="avatar avatar-xs">${esc(ini)}</div>${esc(name)}</div>`;
                }).join("");
            return `<div class="survey-wrap">
              <div class="survey-row">
                <span class="survey-name">${esc(s.name)}</span>
                <a href="${esc(s.url)}" target="_blank" rel="noopener" class="survey-link-icon" title="Open">
                  <i class="ti ti-external-link"></i>
                </a>
                <button class="btn btn-ghost btn-sm" onclick="startEditSurvey('${esc(week.id)}','${esc(s.id)}')" title="Edit"><i class="ti ti-edit"></i></button>
                <button class="btn btn-danger btn-sm" onclick="deleteSurvey('${esc(week.id)}','${esc(s.id)}')" title="Delete"><i class="ti ti-trash"></i></button>
                ${studentsCache.length>0?`<button class="btn btn-ghost btn-sm pending-toggle${allDone?" pending-done":""}"
                  onclick="togglePending('${esc(s.id)}')" title="Who hasn't answered">
                  <i class="ti ti-users"></i>
                  <span class="pending-badge">${pending.length}</span>
                </button>`:""}
              </div>
              <div class="pending-panel" id="pending-${esc(s.id)}" hidden>
                <div class="pending-label">Not answered yet (${pending.length} / ${studentsCache.length})</div>
                <div class="pending-list">${pendingHtml}</div>
              </div>
            </div>`;
          }).join("");
          return `<div class="date-group">
            <div class="date-label"><i class="ti ti-calendar-event" style="font-size:13px"></i>${esc(formatDate(dateKey))}</div>
            ${surveysHtml}
          </div>`;
        }).join("");
    const qaForm=showQA?`<div class="inline-form">
      <div class="form-group"><label class="form-label">Survey name</label><input id="qs-name-${esc(week.id)}" type="text" placeholder="Survey name"/></div>
      <div class="form-group"><label class="form-label">Link</label><input id="qs-url-${esc(week.id)}" type="url" placeholder="https://..."/></div>
      <div class="form-group"><label class="form-label">Date</label><input id="qs-date-${esc(week.id)}" type="date"/></div>
      <p class="err" id="qs-err-${esc(week.id)}"></p>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-outline btn-sm" onclick="toggleQuickAdd('${esc(week.id)}')">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="addSurveyToWeek('${esc(week.id)}')">Add survey</button>
      </div>
    </div>`:"";
    return `<div class="week-block${collapsed?" collapsed":""}">
      <div class="week-header" onclick="toggleWeek('${esc(week.id)}')" role="button">
        <i class="ti ti-calendar-week" style="font-size:16px;color:var(--text-3)"></i>
        <span class="week-label">${esc(week.name)}</span>
        <div class="week-meta">
          <span class="week-count">${week.surveys.length} survey${week.surveys.length!==1?"s":""}</span>
          <i class="ti ti-chevron-down chevron"></i>
        </div>
      </div>
      <div class="week-body">
        ${datesHtml}
        <div class="week-actions">
          <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();toggleQuickAdd('${esc(week.id)}')"><i class="ti ti-plus"></i> Add survey</button>
          <button class="btn btn-danger btn-sm" onclick="deleteWeek('${esc(week.id)}','${esc(week.name)}')"><i class="ti ti-trash"></i> Delete week</button>
        </div>
        ${qaForm}
      </div>
    </div>`;
  }).join("");
}
window.toggleWeek = id => { expandedWeeks[id]=expandedWeeks[id]===false?true:false; renderInstructorWeeks(); };

// ── ASSIGNMENTS: Excel import + render ────────────────────────
function normalizeHeader(value) {
  return String(value || "").replace(/\s/g,"").replace(/[״"]/g,"").toLowerCase();
}

function getAssignmentValue(row, headerMap, keys) {
  for (const key of keys) {
    const index = headerMap[key];
    if (index !== undefined) return row[index] ?? "";
  }
  return "";
}

function parseAssignmentDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!match) return { dueDate: text, dueSort: text };
  const day = match[1].padStart(2,"0");
  const month = match[2].padStart(2,"0");
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return { dueDate: `${day}.${month}.${year.slice(2)}`, dueSort: `${year}-${month}-${day}` };
}

function assignmentLinkHtml(link) {
  if (!link) return "";
  return `<a href="${esc(link)}" target="_blank" rel="noopener" class="open-link assignment-link">
    <i class="ti ti-external-link"></i> קישור
  </a>`;
}

function assignmentCard(a) {
  return `<div class="assignment-card" dir="rtl">
    <div class="assignment-main">
      <div class="assignment-title">${esc(a.name)}</div>
      ${a.dueDate?`<div class="assignment-due"><i class="ti ti-calendar-event"></i> תג״ב: ${esc(a.dueDate)}</div>`:""}
      ${a.instructions?`<div class="assignment-instructions">${esc(a.instructions).replace(/\n/g,"<br>")}</div>`:""}
    </div>
    ${assignmentLinkHtml(a.link)}
  </div>`;
}

function renderAssignmentsList(targetId, emptyText) {
  const c = $(targetId);
  if (!assignmentsCache.length) {
    c.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }
  c.innerHTML = `<div class="assignments-list">${assignmentsCache.map(assignmentCard).join("")}</div>`;
}

function renderGradesAssignments() {
  renderAssignmentsList("grades-assignments-list","No assignments uploaded yet.");
  const summary = $("assignments-upload-summary");
  if (summary) summary.textContent = assignmentsCache.length ? `${assignmentsCache.length} מטלות באתר` : "";
}

function renderStudentAssignments() {
  renderAssignmentsList("student-assignments-list","עדיין אין מטלות להצגה.");
}

window.importAssignmentsExcel = async () => {
  const input = $("assignments-file");
  const file = input?.files?.[0];
  clrErr("assignments-upload-err");
  if (!file) return setErr("assignments-upload-err","Please choose an Excel file.");
  if (!window.XLSX) return setErr("assignments-upload-err","Excel reader is still loading. Try again in a moment.");

  loading(true);
  try {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type:"array", cellDates:true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header:1, defval:"", raw:false });
    const headerIndex = rows.findIndex(row => row.some(cell => normalizeHeader(cell)==="שם"));
    if (headerIndex === -1) throw new Error("Could not find a header row with the column 'שם'.");

    const headers = rows[headerIndex].map(normalizeHeader);
    const headerMap = {};
    headers.forEach((header,index)=>{ if (header) headerMap[header]=index; });

    const parsed = rows.slice(headerIndex+1).map((row,index)=>{
      const name = String(getAssignmentValue(row,headerMap,["שם","מטלה","משימה"])).trim();
      if (!name) return null;
      const due = parseAssignmentDate(getAssignmentValue(row,headerMap,["תגב","תאריך","תאריךיעד","דדליין"]));
      return {
        name,
        dueDate: due.dueDate,
        dueSort: due.dueSort,
        link: String(getAssignmentValue(row,headerMap,["קישורים","קישור","לינק"])).trim(),
        instructions: String(getAssignmentValue(row,headerMap,["הנחיות","הוראות","פירוט"])).trim(),
        order: index + 1,
        importedAt: Date.now()
      };
    }).filter(Boolean);

    if (!parsed.length) throw new Error("No assignment rows were found in the file.");

    const existing = await getDocs(collection(db,"assignments"));
    await Promise.all(existing.docs.map(d=>deleteDoc(d.ref)));
    await Promise.all(parsed.map(item=>addDoc(collection(db,"assignments"),item)));
    input.value = "";
    await refreshAll();
    renderGradesAssignments();
  } catch(e) {
    setErr("assignments-upload-err","Error: "+e.message);
  }
  loading(false);
};

// ── RENDER: instructor students tab ───────────────────────────
async function renderStudentsTab() {
  const c=$("students-list"); c.innerHTML='<div class="empty">Loading…</div>';
  try {
    const snap=await getDocs(collection(db,"students"));
    const total=weeksCache.reduce((a,w)=>a+w.surveys.length,0);
    if (snap.empty){ c.innerHTML='<div class="empty">No students yet.</div>'; return; }
    const existIds=new Set(weeksCache.flatMap(w=>w.surveys.map(s=>s.id)));
    const rows=await Promise.all(snap.docs.map(async d=>{
      const name=d.id;
      const ini=name.split(" ").map(x=>x[0]).join("").toUpperCase().slice(0,2);
      let done=0;
      try { const cs=await getDocs(collection(db,"completions",name,"done")); done=cs.docs.filter(d=>existIds.has(d.id)).length; } catch{}
      const pct=total?Math.round(done/total*100):0;
      return `<div class="student-row">
        <div class="avatar">${esc(ini)}</div>
        <div class="student-info"><div class="student-name">${esc(name)}</div>
          <div class="student-prog-track"><div class="student-prog-fill" style="width:${pct}%"></div></div>
        </div>
        <span class="student-stat">${done} / ${total}</span>
      </div>`;
    }));
    c.innerHTML=`<p style="font-size:13px;color:var(--text-3);margin-bottom:12px">${snap.size} student${snap.size!==1?"s":""} registered</p>
      <div class="card" style="padding:4px 14px">${rows.join("")}</div>`;
  } catch(e){ c.innerHTML=`<div class="empty">Error: ${esc(e.message)}</div>`; }
}

// ── SUBJECTS: add / delete / render ───────────────────────────
window.toggleAddSubject = () => {
  const f=$("add-subject-form"); f.hidden=!f.hidden;
  if (!f.hidden){ clrErr("new-subject-err"); $("new-subject-name").focus(); }
};
window.addSubject = async () => {
  clrErr("new-subject-err");
  const name=$("new-subject-name").value.trim();
  if (!name) return setErr("new-subject-err","Please enter a subject name.");
  loading(true);
  try {
    await addDoc(collection(db,"subjects"),{name,createdAt:Date.now()});
    $("new-subject-name").value="";
    $("add-subject-form").hidden=true;
    await refreshAll();
  } catch(e){ setErr("new-subject-err","Error: "+e.message); }
  loading(false);
};
window.deleteSubject = async (id,name) => {
  if (!confirm(`Delete subject "${name}"? All student grades for this subject will also be deleted.`)) return;
  loading(true);
  try {
    // Delete grades for all students for this subject
    await Promise.all(studentsCache.map(async sName=>{
      try { await deleteDoc(doc(db,"grades",sName,"scores",id)); } catch{}
    }));
    await deleteDoc(doc(db,"subjects",id));
    await refreshAll();
  } catch(e){ alert("Error: "+e.message); }
  loading(false);
};

function renderSubjects() {
  const c=$("subjects-list");
  if (!subjectsCache.length){ c.innerHTML='<div class="empty">No subjects yet. Click "Add subject" to get started.</div>'; return; }
  c.innerHTML=subjectsCache.map(sub=>`
    <div class="week-block">
      <div class="week-header" style="cursor:default">
        <i class="ti ti-books" style="font-size:16px;color:var(--text-3)"></i>
        <span class="week-label">${esc(sub.name)}</span>
        <div class="week-meta">
          <button class="btn btn-danger btn-sm" onclick="deleteSubject('${esc(sub.id)}','${esc(sub.name)}')">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </div>
    </div>`).join("");
}

// ── GRADES OVERVIEW (grades instructor) ───────────────────────
let gradesMapCache = {};

function exportCell(value) {
  return esc(value === undefined || value === null ? "" : value);
}

window.exportGradesToExcel = () => {
  if (!subjectsCache.length || !studentsCache.length) {
    alert("There are no grades to export yet.");
    return;
  }

  const headerCells = subjectsCache.map(sub => `<th>${exportCell(sub.name)}</th>`).join("");
  const rows = studentsCache.map(name => {
    const cells = subjectsCache.map(sub => `<td>${exportCell(gradesMapCache[name]?.[sub.id])}</td>`).join("");
    return `<tr><td>${exportCell(name)}</td>${cells}</tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    table { border-collapse: collapse; }
    th, td { border: 1px solid #999; padding: 6px 10px; text-align: center; }
    th:first-child, td:first-child { text-align: left; }
  </style>
</head>
<body>
  <table>
    <thead><tr><th>Student</th>${headerCells}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;

  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `grades-table-${todayISO()}.xls`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

window.filterGrades = () => {
  const q = ($("grades-search")?.value || "").trim().toLowerCase();
  const rows = document.querySelectorAll(".grades-table tbody tr");
  let visible = 0;
  rows.forEach(row => {
    const name = (row.querySelector(".grade-student-name")?.textContent || "").toLowerCase();
    const show = name.includes(q);
    row.style.display = show ? "" : "none";
    if (show) visible++;
  });
  const empty = $("grades-no-results");
  if (empty) empty.hidden = visible > 0;
};

async function renderGradesOverview() {
  const c=$("grades-overview"); c.innerHTML='<div class="empty">Loading…</div>';
  if (!subjectsCache.length){ c.innerHTML='<div class="empty">No subjects added yet.</div>'; return; }
  if (!studentsCache.length){ c.innerHTML='<div class="empty">No students registered yet.</div>'; return; }
  try {
    gradesMapCache={};
    await Promise.all(studentsCache.map(async name=>{
      gradesMapCache[name]={};
      try {
        const snap=await getDocs(collection(db,"grades",name,"scores"));
        snap.forEach(d=>{ gradesMapCache[name][d.id]=d.data().grade; });
      } catch{}
    }));

    const headerCells=subjectsCache.map(s=>`<th class="grade-th">${esc(s.name)}</th>`).join("");
    const rows=studentsCache.map(name=>{
      const ini=name.split(" ").map(x=>x[0]).join("").toUpperCase().slice(0,2);
      const cells=subjectsCache.map(sub=>{
        const g=gradesMapCache[name]?.[sub.id];
        return `<td class="grade-td">${g!==undefined?`<span class="grade-pill">${esc(String(g))}</span>`:'<span class="grade-empty">—</span>'}</td>`;
      }).join("");
      return `<tr>
        <td class="grade-student-cell">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="avatar avatar-xs">${esc(ini)}</div>
            <span class="grade-student-name" style="font-size:13px;font-weight:500">${esc(name)}</span>
          </div>
        </td>
        ${cells}
      </tr>`;
    }).join("");

    c.innerHTML=`
      <div class="grades-toolbar">
        <div class="search-bar-wrap">
          <div class="search-bar">
            <i class="ti ti-search search-icon"></i>
            <input type="text" id="grades-search" placeholder="Search student…"
              oninput="filterGrades()" autocomplete="off" />
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="exportGradesToExcel()">
          <i class="ti ti-file-spreadsheet"></i> Export Excel
        </button>
      </div>
      <div class="grades-table-wrap">
        <table class="grades-table">
          <thead><tr><th class="grade-th grade-name-th">Student</th>${headerCells}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div id="grades-no-results" class="empty" hidden>No students match your search.</div>
      </div>`;
  } catch(e){ c.innerHTML=`<div class="empty">Error: ${esc(e.message)}</div>`; }
}

// ── STUDENT: render surveys tab ───────────────────────────────
async function renderStudentView() {
  const progWrap=$("student-progress-wrap"), weeksEl=$("student-weeks");
  let comp={};
  try { (await getDocs(collection(db,"completions",currentUser,"done"))).forEach(d=>{comp[d.id]=true;}); } catch{}
  const total=weeksCache.reduce((a,w)=>a+w.surveys.length,0);
  const existIds=new Set(weeksCache.flatMap(w=>w.surveys.map(s=>s.id)));
  const done=Object.keys(comp).filter(id=>existIds.has(id)).length;
  const pct=total?Math.round(done/total*100):0;
  progWrap.innerHTML=`
    <div class="progress-title">Your progress</div>
    <div class="progress-numbers"><span class="progress-big">${done}</span><span class="progress-of">of ${total} surveys completed</span></div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="progress-label">${pct}% complete</div>`;
  if (!weeksCache.length){ weeksEl.innerHTML='<div class="empty">No surveys assigned yet.</div>'; return; }
  weeksEl.innerHTML=weeksCache.map(week=>{
    const wDone=week.surveys.filter(s=>existIds.has(s.id)&&comp[s.id]).length;
    const wTotal=week.surveys.filter(s=>existIds.has(s.id)).length;
    const allDone=wTotal>0&&wDone===wTotal;
    const byDate=groupByDate(week.surveys);
    const datesHtml=byDate.map(([dateKey,surveys])=>{
      const rows=surveys.map(s=>{
        const checked=comp[s.id]?"checked":"";
        return `<div class="check-row">
          <input type="checkbox" id="chk-${esc(s.id)}" ${checked} onchange="toggleComplete('${esc(s.id)}',this.checked)"/>
          <label class="check-label${checked?" done":""}" for="chk-${esc(s.id)}">${esc(s.name)}</label>
          <a href="${esc(s.url)}" target="_blank" rel="noopener" class="open-link"><i class="ti ti-external-link"></i> Open</a>
        </div>`;
      }).join("");
      return `<div class="date-group">
        <div class="date-label"><i class="ti ti-calendar-event" style="font-size:13px"></i>${esc(formatDate(dateKey))}</div>
        ${rows}
      </div>`;
    }).join("");
    return `<div class="week-block">
      <div class="week-header" style="cursor:default">
        <i class="ti ti-calendar-week" style="font-size:16px;color:var(--text-3)"></i>
        <span class="week-label">${esc(week.name)}</span>
        <div class="week-meta">
          <span class="week-count${allDone?" all-done":""}">${wDone} / ${wTotal}</span>
          ${allDone?'<i class="ti ti-circle-check" style="font-size:16px;color:var(--green)"></i>':""}
        </div>
      </div>
      <div class="week-body">${datesHtml}</div>
    </div>`;
  }).join("");
}
window.toggleComplete = async (surveyId,checked)=>{
  try {
    const ref=doc(db,"completions",currentUser,"done",surveyId);
    if(checked) await setDoc(ref,{done:true,at:Date.now()}); else await deleteDoc(ref);
    renderStudentView();
  } catch(e){ alert("Error: "+e.message); }
};

// ── STUDENT: render grades tab ────────────────────────────────
async function renderStudentGrades() {
  const c=$("student-grades-list");
  if (!subjectsCache.length){ c.innerHTML='<div class="empty">No subjects have been added yet.</div>'; return; }
  // Load student's current grades
  let myGrades={};
  try {
    const snap=await getDocs(collection(db,"grades",currentUser,"scores"));
    snap.forEach(d=>{ myGrades[d.id]=d.data().grade; });
  } catch{}
  c.innerHTML=subjectsCache.map(sub=>{
    const current=myGrades[sub.id]!==undefined?myGrades[sub.id]:"";
    return `<div class="week-block">
      <div class="week-header" style="cursor:default;padding:12px 14px">
        <i class="ti ti-books" style="font-size:16px;color:var(--text-3)"></i>
        <span class="week-label">${esc(sub.name)}</span>
        <div class="grade-input-row">
          <input type="number" min="0" max="100"
            id="grade-input-${esc(sub.id)}"
            value="${esc(String(current))}"
            placeholder="0–100"
            class="grade-number-input"
            onchange="saveStudentGrade('${esc(sub.id)}',this.value)"
          />
        </div>
      </div>
    </div>`;
  }).join("");
}
window.saveStudentGrade = async (subjectId, value) => {
  const num = parseInt(value, 10);
  if (isNaN(num)||num<0||num>100) { alert("Please enter a number between 0 and 100."); return; }
  try {
    await setDoc(doc(db,"grades",currentUser,"scores",subjectId),{grade:num,at:Date.now()});
  } catch(e){ alert("Error saving grade: "+e.message); }
};

// ── Keyboard shortcuts ────────────────────────────────────────
document.addEventListener("keydown", e=>{
  if (e.key!=="Enter") return;
  const id=document.querySelector(".screen.active")?.id;
  if (id==="screen-instructor-login") instructorLogin();
  else if (id==="screen-grades-login")   gradesLogin();
  else if (id==="screen-student-login")  studentLogin();
  else if (id==="screen-student-signup") studentSignup();
});

// ── Auto-refresh every 20s ────────────────────────────────────
setInterval(()=>refreshAll(), 20000);

// ── Boot ──────────────────────────────────────────────────────
(async()=>{
  loading(true);
  await refreshAll();
  if (currentRole==="instructor"){
    updateTopbar("Surveys Instructor","Instructor");
    renderInstructorWeeks(); showScreen("screen-instructor");
  } else if (currentRole==="grades"){
    updateTopbar("Grades Instructor","Grades Instructor");
    renderSubjects(); showScreen("screen-grades");
  } else if (currentRole==="student"&&currentUser){
    updateTopbar("Student",currentUser);
    renderStudentAssignments(); showScreen("screen-student");
  }
  loading(false);
})();
