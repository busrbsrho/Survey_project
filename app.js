// ─────────────────────────────────────────────────────────────
//  SurveyTrack — app.js  (Firebase Firestore version)
// ─────────────────────────────────────────────────────────────

import { initializeApp }                          from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, doc,
         getDocs, getDoc, setDoc, addDoc,
         updateDoc, deleteDoc, onSnapshot,
         query, orderBy }                         from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, INSTRUCTOR_CREDS }       from "./firebase-config.js";

// ── Init ────────────────────────────────────────────────────
const firebaseApp = initializeApp(firebaseConfig);
const db          = getFirestore(firebaseApp);

// ── Firestore collection references ─────────────────────────
// weeks/{weekId}                  → { name, order, createdAt }
// weeks/{weekId}/surveys/{survId} → { name, url, createdAt }
// students/{name}                 → { pass, createdAt }
// completions/{name}/done/{survId}→ { done: true }

const weeksCol      = collection(db, "weeks");
const studentsCol   = collection(db, "students");

// ── Local cache (kept in sync via onSnapshot) ────────────────
let weeksCache   = [];   // [{ id, name, order, surveys: [{id,name,url}] }]
let studentsCache = {};  // { name: { pass } }

// ── Session ──────────────────────────────────────────────────
let currentUser = null;
let currentRole = null;

// ── UI state ─────────────────────────────────────────────────
let expandedWeeks = {};
let quickAddWeeks = {};
let editingEntry  = null;

// ── Helpers ──────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function setError(id, msg) { const el = $(id); if (el) el.textContent = msg; }
function clearError(id)    { setError(id, ""); }

function showLoading(on) {
  $("loading-overlay").style.display = on ? "flex" : "none";
}

// ── Screens ──────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id)?.classList.add("active");
}
window.showScreen = showScreen;

function updateTopbar(role, name) {
  $("topbar-sub").textContent = name;
  $("role-badge").textContent = role;
  $("role-badge").hidden = false;
  $("signout-btn").hidden = false;
}

function signOut() {
  currentUser = null; currentRole = null;
  $("role-badge").hidden = true;
  $("signout-btn").hidden = true;
  $("topbar-sub").textContent = "Sign in to continue";
  ["ins-user","ins-pass","slogin-name","slogin-pass","signup-name","signup-pass"]
    .forEach(id => { const el = $(id); if (el) el.value = ""; });
  ["ins-err","slogin-err","signup-err"].forEach(clearError);
  $("tab-surveys").hidden = false;
  $("tab-students").hidden = true;
  document.querySelectorAll(".tab").forEach((t, i) => {
    t.classList.toggle("active", i === 0);
    t.setAttribute("aria-selected", i === 0 ? "true" : "false");
  });
  showScreen("screen-pick");
}
window.signOut = signOut;

// ── Live listener: weeks + their surveys ─────────────────────
function subscribeWeeks() {
  const q = query(weeksCol, orderBy("order", "asc"));
  onSnapshot(q, async (snapshot) => {
    const weeks = [];
    for (const weekDoc of snapshot.docs) {
      const data = weekDoc.data();
      // Load surveys sub-collection
      const surveysSnap = await getDocs(
        query(collection(db, "weeks", weekDoc.id, "surveys"), orderBy("createdAt", "asc"))
      );
      const surveys = surveysSnap.docs.map(s => ({ id: s.id, ...s.data() }));
      weeks.push({ id: weekDoc.id, name: data.name, order: data.order, surveys });
    }
    weeksCache = weeks;
    if (currentRole === "instructor") renderInstructorWeeks();
    if (currentRole === "student")    renderStudentView();
  });
}

// ── Auth: Instructor ─────────────────────────────────────────
async function instructorLogin() {
  clearError("ins-err");
  const u = $("ins-user").value.trim();
  const p = $("ins-pass").value;
  if (u === INSTRUCTOR_CREDS.user && p === INSTRUCTOR_CREDS.pass) {
    currentRole = "instructor"; currentUser = "instructor";
    updateTopbar("Instructor", "Instructor");
    renderInstructorWeeks();
    showScreen("screen-instructor");
  } else {
    setError("ins-err", "Incorrect credentials.");
  }
}
window.instructorLogin = instructorLogin;

// ── Auth: Student signup ──────────────────────────────────────
async function studentSignup() {
  clearError("signup-err");
  const name = $("signup-name").value.trim();
  const pass = $("signup-pass").value;
  if (!name)           return setError("signup-err", "Please enter your full name.");
  if (pass.length < 4) return setError("signup-err", "Password must be at least 4 characters.");

  showLoading(true);
  try {
    const docRef = doc(studentsCol, name);
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      showLoading(false);
      return setError("signup-err", "That name is already registered. Try signing in.");
    }
    await setDoc(docRef, { pass, createdAt: Date.now() });
    currentUser = name; currentRole = "student";
    updateTopbar("Student", name);
    await renderStudentView();
    showScreen("screen-student");
  } catch (e) {
    setError("signup-err", "Error: " + e.message);
  }
  showLoading(false);
}
window.studentSignup = studentSignup;

// ── Auth: Student login ───────────────────────────────────────
async function studentLogin() {
  clearError("slogin-err");
  const name = $("slogin-name").value.trim();
  const pass = $("slogin-pass").value;

  showLoading(true);
  try {
    const snap = await getDoc(doc(studentsCol, name));
    if (!snap.exists() || snap.data().pass !== pass) {
      showLoading(false);
      return setError("slogin-err", "Name or password is incorrect.");
    }
    currentUser = name; currentRole = "student";
    updateTopbar("Student", name);
    await renderStudentView();
    showScreen("screen-student");
  } catch (e) {
    setError("slogin-err", "Error: " + e.message);
  }
  showLoading(false);
}
window.studentLogin = studentLogin;

// ── Instructor: tabs ──────────────────────────────────────────
function switchTab(tab) {
  const isSurveys = tab === "surveys";
  $("tab-surveys").hidden  = !isSurveys;
  $("tab-students").hidden =  isSurveys;
  $("tab-btn-surveys").classList.toggle("active", isSurveys);
  $("tab-btn-surveys").setAttribute("aria-selected", String(isSurveys));
  $("tab-btn-students").classList.toggle("active", !isSurveys);
  $("tab-btn-students").setAttribute("aria-selected", String(!isSurveys));
  if (!isSurveys) renderStudents();
}
window.switchTab = switchTab;

// ── Instructor: add week ──────────────────────────────────────
function toggleAddWeek() {
  const f = $("add-week-form");
  f.hidden = !f.hidden;
  if (!f.hidden) { clearError("new-week-err"); $("new-week-name").focus(); }
}
window.toggleAddWeek = toggleAddWeek;

async function addWeek() {
  clearError("new-week-err");
  const wn = $("new-week-name").value.trim();
  const sn = $("new-survey-name").value.trim();
  const su = $("new-survey-url").value.trim();
  if (!wn) return setError("new-week-err", "Please enter a week name or theme.");
  if (!sn) return setError("new-week-err", "Please enter the first survey name.");
  if (!su) return setError("new-week-err", "Please enter the survey URL.");

  showLoading(true);
  try {
    // Create week document
    const weekRef = await addDoc(weeksCol, {
      name: wn,
      order: Date.now(),
      createdAt: Date.now(),
    });
    // Add first survey to sub-collection
    await addDoc(collection(db, "weeks", weekRef.id, "surveys"), {
      name: sn, url: su, createdAt: Date.now(),
    });
    $("new-week-name").value = "";
    $("new-survey-name").value = "";
    $("new-survey-url").value = "";
    $("add-week-form").hidden = true;
  } catch (e) {
    setError("new-week-err", "Error saving: " + e.message);
  }
  showLoading(false);
}
window.addWeek = addWeek;

// ── Instructor: quick-add survey to existing week ─────────────
function toggleQuickAdd(weekId) {
  quickAddWeeks[weekId] = !quickAddWeeks[weekId];
  renderInstructorWeeks();
  if (quickAddWeeks[weekId]) {
    setTimeout(() => $("qs-name-" + weekId)?.focus(), 50);
  }
}
window.toggleQuickAdd = toggleQuickAdd;

async function addSurveyToWeek(weekId) {
  const errId = "qs-err-" + weekId;
  clearError(errId);
  const sn = $("qs-name-" + weekId)?.value.trim();
  const su = $("qs-url-" + weekId)?.value.trim();
  if (!sn || !su) return setError(errId, "Please fill in both fields.");

  showLoading(true);
  try {
    await addDoc(collection(db, "weeks", weekId, "surveys"), {
      name: sn, url: su, createdAt: Date.now(),
    });
    quickAddWeeks[weekId] = false;
  } catch (e) {
    setError(errId, "Error: " + e.message);
  }
  showLoading(false);
}
window.addSurveyToWeek = addSurveyToWeek;

// ── Instructor: delete ────────────────────────────────────────
async function deleteWeek(weekId, weekName) {
  if (!confirm(`Delete "${weekName}" and all its surveys?`)) return;
  showLoading(true);
  try {
    // Delete all surveys first
    const surveysSnap = await getDocs(collection(db, "weeks", weekId, "surveys"));
    for (const s of surveysSnap.docs) await deleteDoc(s.ref);
    await deleteDoc(doc(db, "weeks", weekId));
    delete expandedWeeks[weekId];
    delete quickAddWeeks[weekId];
  } catch (e) { alert("Error deleting: " + e.message); }
  showLoading(false);
}
window.deleteWeek = deleteWeek;

async function deleteSurvey(weekId, surveyId) {
  showLoading(true);
  try {
    await deleteDoc(doc(db, "weeks", weekId, "surveys", surveyId));
  } catch (e) { alert("Error: " + e.message); }
  showLoading(false);
}
window.deleteSurvey = deleteSurvey;

// ── Instructor: edit ──────────────────────────────────────────
function startEditSurvey(weekId, surveyId) {
  editingEntry = { weekId, surveyId };
  renderInstructorWeeks();
  setTimeout(() => $("edit-name-" + surveyId)?.focus(), 50);
}
window.startEditSurvey = startEditSurvey;

function cancelEdit() { editingEntry = null; renderInstructorWeeks(); }
window.cancelEdit = cancelEdit;

async function saveEditSurvey(weekId, surveyId) {
  const newName = $("edit-name-" + surveyId)?.value.trim();
  const newUrl  = $("edit-url-" + surveyId)?.value.trim();
  if (!newName || !newUrl) return;
  showLoading(true);
  try {
    await updateDoc(doc(db, "weeks", weekId, "surveys", surveyId), {
      name: newName, url: newUrl,
    });
    editingEntry = null;
  } catch (e) { alert("Error: " + e.message); }
  showLoading(false);
}
window.saveEditSurvey = saveEditSurvey;

// ── Instructor: render weeks ──────────────────────────────────
function renderInstructorWeeks() {
  const container = $("instructor-weeks");
  if (!weeksCache.length) {
    container.innerHTML = '<div class="empty">No weeks yet. Click "Add week" to get started.</div>';
    return;
  }
  container.innerHTML = weeksCache.map(week => {
    const isCollapsed = expandedWeeks[week.id] === false;
    const showQA      = quickAddWeeks[week.id];

    const surveysHtml = week.surveys.map(s => {
      if (editingEntry?.weekId === week.id && editingEntry?.surveyId === s.id) {
        return `
          <div class="survey-row">
            <div class="edit-row-inputs">
              <input id="edit-name-${esc(s.id)}" type="text" value="${esc(s.name)}" placeholder="Survey name" />
              <input id="edit-url-${esc(s.id)}"  type="url"  value="${esc(s.url)}"  placeholder="https://..." />
            </div>
            <button class="btn btn-primary btn-sm" onclick="saveEditSurvey('${esc(week.id)}','${esc(s.id)}')">Save</button>
            <button class="btn btn-ghost btn-sm"   onclick="cancelEdit()">Cancel</button>
          </div>`;
      }
      return `
        <div class="survey-row">
          <span class="survey-name">${esc(s.name)}</span>
          <a href="${esc(s.url)}" target="_blank" rel="noopener" class="survey-link-icon" title="Open survey">
            <i class="ti ti-external-link" aria-hidden="true"></i>
          </a>
          <button class="btn btn-ghost btn-sm" onclick="startEditSurvey('${esc(week.id)}','${esc(s.id)}')" title="Edit">
            <i class="ti ti-edit" aria-hidden="true"></i>
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteSurvey('${esc(week.id)}','${esc(s.id)}')" title="Delete">
            <i class="ti ti-trash" aria-hidden="true"></i>
          </button>
        </div>`;
    }).join("") || '<div class="empty" style="padding:6px 0 2px">No surveys yet.</div>';

    const qaForm = showQA ? `
      <div class="inline-form">
        <div class="form-group">
          <label class="form-label">Survey name</label>
          <input id="qs-name-${esc(week.id)}" type="text" placeholder="Survey name" />
        </div>
        <div class="form-group">
          <label class="form-label">Link</label>
          <input id="qs-url-${esc(week.id)}" type="url" placeholder="https://..." />
        </div>
        <p class="err" id="qs-err-${esc(week.id)}"></p>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-outline btn-sm" onclick="toggleQuickAdd('${esc(week.id)}')">Cancel</button>
          <button class="btn btn-primary btn-sm" onclick="addSurveyToWeek('${esc(week.id)}')">Add survey</button>
        </div>
      </div>` : "";

    return `
      <div class="week-block${isCollapsed ? " collapsed" : ""}">
        <div class="week-header" onclick="toggleWeek('${esc(week.id)}')" role="button" aria-expanded="${!isCollapsed}">
          <i class="ti ti-calendar-week" aria-hidden="true" style="font-size:16px;color:var(--text-3)"></i>
          <span class="week-label">${esc(week.name)}</span>
          <div class="week-meta">
            <span class="week-count">${week.surveys.length} survey${week.surveys.length !== 1 ? "s" : ""}</span>
            <i class="ti ti-chevron-down chevron" aria-hidden="true"></i>
          </div>
        </div>
        <div class="week-body">
          ${surveysHtml}
          <div class="week-actions">
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); toggleQuickAdd('${esc(week.id)}')">
              <i class="ti ti-plus" aria-hidden="true"></i> Add survey
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteWeek('${esc(week.id)}', '${esc(week.name)}')">
              <i class="ti ti-trash" aria-hidden="true"></i> Delete week
            </button>
          </div>
          ${qaForm}
        </div>
      </div>`;
  }).join("");
}

function toggleWeek(id) {
  expandedWeeks[id] = expandedWeeks[id] === false ? true : false;
  renderInstructorWeeks();
}
window.toggleWeek = toggleWeek;

// ── Instructor: students view ─────────────────────────────────
async function renderStudents() {
  const container = $("students-list");
  container.innerHTML = '<div class="empty">Loading students…</div>';
  try {
    const snap = await getDocs(studentsCol);
    const total = weeksCache.reduce((a, w) => a + w.surveys.length, 0);
    if (snap.empty) {
      container.innerHTML = '<div class="empty">No students have registered yet.</div>';
      return;
    }
    const rows = await Promise.all(snap.docs.map(async d => {
      const name = d.id;
      const initials = name.split(" ").map(x => x[0]).join("").toUpperCase().slice(0, 2);
      // Count completions
      let done = 0;
      try {
        const compSnap = await getDocs(collection(db, "completions", name, "done"));
        done = compSnap.size;
      } catch {}
      const pct = total ? Math.round((done / total) * 100) : 0;
      return `
        <div class="student-row">
          <div class="avatar">${esc(initials)}</div>
          <div class="student-info">
            <div class="student-name">${esc(name)}</div>
            <div class="student-prog-track">
              <div class="student-prog-fill" style="width:${pct}%"></div>
            </div>
          </div>
          <span class="student-stat">${done} / ${total}</span>
        </div>`;
    }));
    container.innerHTML = `
      <p style="font-size:13px;color:var(--text-3);margin-bottom:12px">
        ${snap.size} student${snap.size !== 1 ? "s" : ""} registered
      </p>
      <div class="card" style="padding:4px 14px">${rows.join("")}</div>`;
  } catch (e) {
    container.innerHTML = `<div class="empty">Error loading students: ${esc(e.message)}</div>`;
  }
}

// ── Student: render ───────────────────────────────────────────
async function renderStudentView() {
  const progWrap = $("student-progress-wrap");
  const weeksEl  = $("student-weeks");

  // Load completions from Firestore
  let comp = {};
  try {
    const compSnap = await getDocs(collection(db, "completions", currentUser, "done"));
    compSnap.forEach(d => { comp[d.id] = true; });
  } catch {}

  const total = weeksCache.reduce((a, w) => a + w.surveys.length, 0);
  const done  = Object.keys(comp).length;
  const pct   = total ? Math.round((done / total) * 100) : 0;

  progWrap.innerHTML = `
    <div class="progress-title">Your progress</div>
    <div class="progress-numbers">
      <span class="progress-big">${done}</span>
      <span class="progress-of">of ${total} surveys completed</span>
    </div>
    <div class="progress-track">
      <div class="progress-fill" style="width:${pct}%"></div>
    </div>
    <div class="progress-label">${pct}% complete</div>`;

  if (!weeksCache.length) {
    weeksEl.innerHTML = '<div class="empty">No surveys have been assigned yet. Check back later!</div>';
    return;
  }

  weeksEl.innerHTML = weeksCache.map(week => {
    const wDone   = week.surveys.filter(s => comp[s.id]).length;
    const allDone = wDone === week.surveys.length && week.surveys.length > 0;
    const rows = week.surveys.map(s => {
      const checked = comp[s.id] ? "checked" : "";
      return `
        <div class="check-row">
          <input type="checkbox" id="chk-${esc(s.id)}" ${checked}
            onchange="toggleComplete('${esc(s.id)}', this.checked)" />
          <label class="check-label${checked ? " done" : ""}" for="chk-${esc(s.id)}">
            ${esc(s.name)}
          </label>
          <a href="${esc(s.url)}" target="_blank" rel="noopener" class="open-link">
            <i class="ti ti-external-link" aria-hidden="true"></i> Open
          </a>
        </div>`;
    }).join("");
    return `
      <div class="week-block">
        <div class="week-header" style="cursor:default">
          <i class="ti ti-calendar-week" aria-hidden="true" style="font-size:16px;color:var(--text-3)"></i>
          <span class="week-label">${esc(week.name)}</span>
          <div class="week-meta">
            <span class="week-count${allDone ? " all-done" : ""}">${wDone} / ${week.surveys.length}</span>
            ${allDone ? '<i class="ti ti-circle-check" style="font-size:16px;color:var(--green)"></i>' : ""}
          </div>
        </div>
        <div class="week-body">${rows}</div>
      </div>`;
  }).join("");
}

async function toggleComplete(surveyId, checked) {
  try {
    const ref = doc(db, "completions", currentUser, "done", surveyId);
    if (checked) {
      await setDoc(ref, { done: true, at: Date.now() });
    } else {
      await deleteDoc(ref);
    }
    await renderStudentView();
  } catch (e) { alert("Error saving: " + e.message); }
}
window.toggleComplete = toggleComplete;

// ── Keyboard: Enter to submit ─────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const active = document.querySelector(".screen.active")?.id;
  if (active === "screen-instructor-login") instructorLogin();
  else if (active === "screen-student-login")  studentLogin();
  else if (active === "screen-student-signup") studentSignup();
});

// ── Boot ──────────────────────────────────────────────────────
showLoading(true);
subscribeWeeks();
showLoading(false);
