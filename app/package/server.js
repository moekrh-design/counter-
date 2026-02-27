const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const AdmZip = require('adm-zip');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
let ArabicReshaper = null;
try { ArabicReshaper = require('arabic-persian-reshaper'); } catch(e) { ArabicReshaper = null; }

const app = express();
const PORT = process.env.PORT || 3000;
// === DEBUG LOGS (Render) ===
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED_REJECTION:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION:', err && err.stack ? err.stack : err);
});

// Log every request
app.use((req, res, next) => {
  console.log('REQ', req.method, req.url);
  next();
});
const upload = multer({ dest: path.join(__dirname, 'data', 'uploads') });

// Branding uploads (logo)
const brandingDir = path.join(__dirname, 'public', 'branding');
fs.mkdirSync(brandingDir, { recursive: true });
const brandingUpload = multer({
  storage: multer.diskStorage({
    destination: function(req, file, cb){
      cb(null, brandingDir);
    },
    filename: function(req, file, cb){
      const ext = (path.extname(file.originalname || '') || '.png').toLowerCase();
      cb(null, 'logo' + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 10 }
}));

// ---- JSON DB ----
const DB_PATH = path.join(__dirname, 'data', 'db.json');
let db = null;

// ---- Time helpers (Asia/Riyadh) ----
const APP_TZ = 'Asia/Riyadh';

function tzParts(tz=APP_TZ){
  // Use Intl to reliably get local date/time parts for a timezone.
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(d);
  const get = (t)=> (parts.find(p=>p.type===t)?.value) || '';
  const yyyy = get('year');
  const mm = get('month');
  const dd = get('day');
  const hh = get('hour');
  const mi = get('minute');
  const ss = get('second');
  const date = `${yyyy}-${mm}-${dd}`;
  const time = `${hh}:${mi}:${ss}`;
  const minutes = (Number(hh)||0)*60 + (Number(mi)||0);
  return { date, time, hh, mi, ss, minutes };
}

function todayStr(){
  return tzParts(APP_TZ).date;
}

function formatIssueDateTime(iso, tz=APP_TZ){
  // Returns {date:'YYYY-MM-DD', time:'HH:MM'}
  try{
    const d = new Date(iso);
    const fmtD = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
    const fmtT = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour:'2-digit', minute:'2-digit', hour12:false });
    return { date: fmtD.format(d), time: fmtT.format(d) };
  }catch(e){
    return { date:'', time:'' };
  }
}

function isWithinWorkHours(settings){
  const wh = (settings && settings.work_hours) ? settings.work_hours : null;
  if (!wh || wh.enabled === false) return true;

  // Optional weekday gate (0=Sun .. 6=Sat) in APP_TZ
  try{
    const days = Array.isArray(wh.days) ? wh.days.map(x=>Number(x)).filter(x=>Number.isFinite(x)) : null;
    if (days && days.length){
      const wdStr = new Intl.DateTimeFormat('en-US', { timeZone: APP_TZ, weekday: 'short' }).format(new Date());
      const map = {Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6};
      const wd = (map[wdStr] !== undefined) ? map[wdStr] : null;
      if (wd != null && !days.includes(wd)) return false;
    }
  }catch(e){}

  const start = String(wh.start_time || '00:00');
  const end = String(wh.end_time || '23:59');
  const m = tzParts(APP_TZ).minutes;
  const toMin = (hhmm)=>{
    const m2 = String(hhmm||'').match(/^(\d{1,2}):(\d{2})/);
    if(!m2) return 0;
    const h = Math.min(23, Math.max(0, Number(m2[1])));
    const mi = Math.min(59, Math.max(0, Number(m2[2])));
    return h*60 + mi;
  };
  const sMin = toMin(start);
  const eMin = toMin(end);
  // Normal case: start <= end (same day). If overnight (start > end), allow wrap.
  if (sMin <= eMin) return (m >= sMin && m <= eMin);
  return (m >= sMin || m <= eMin);
}

function dateAddDaysStr(isoDateStr, days){
  try{
    const d = new Date(isoDateStr + 'T00:00:00');
    d.setDate(d.getDate() + Number(days||0));
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${yyyy}-${mm}-${dd}`;
  }catch(e){
    return isoDateStr;
  }
}
function dayOfWeek0Sun(dateStr){
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDay();
}

function clampDateStr(s){
  const m = String(s||'').match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? m[0] : null;
}
function toDateOnly(iso){
  if (!iso) return null;
  try{ return new Date(iso).toISOString().slice(0,10); }catch(e){ return null; }
}
function inDateRange(dateStr, fromStr, toStr){
  if (!dateStr) return false;
  if (fromStr && dateStr < fromStr) return false;
  if (toStr && dateStr > toStr) return false;
  return true;
}

function seedDb(){
  const workDate = todayStr();
  const counters = [];
  for (let i=1;i<=10;i++){
    counters.push({id:i, name:`كونتر ${i}`, location:'', is_active:true, priority_order:i});
  }
  const counter_daily = counters.map(c => ({work_date: workDate, counter_id: c.id, enabled_today: true}));
  return {
    system: {
      version: '0.2.0',
      last_update_at: null,
      last_update_note: null
    },
    settings: {
      rest_seconds_default: 30,
      rest_seconds_min: 10,
      rest_seconds_max: 180,
      auto_call_enabled: true,
      counter_overrides: {},
      no_show_max_rounds: 3,
      feedback_window_seconds: 120,
      question1_text: 'هل تم إنجاز طلبك؟',
      question2_text: 'قيّم خدمة الموظف',
      appointments: {
        enabled: true,
        weekday: 4, // Thursday
        start_time: "10:00",
        end_time: "12:00",
        slot_minutes: 15
      },
      ui: {
        theme: 'dark',              // light | dark
        kiosk_return_seconds: 10,   // return to start after ticket issued
        kiosk_auto_print: true,     // try window.print() automatically
        kiosk_printing_mode: 'browser', // browser | chrome_kiosk (silent printing requires browser flags)
        kiosk_show_fullscreen_hint: false,
        kiosk_auto_fullscreen: true
      },
      branding: {
        org_name_ar: 'وزارة التعليم',
        org_name_en: 'Ministry of Education',
        org_unit_ar: 'مكتب رعاية المستفيدين',
        org_unit_en: 'Beneficiary Care Office',
        location_ar: 'المملكة العربية السعودية',
        location_en: 'Kingdom of Saudi Arabia',
        logo_path: '/public/branding/logo.svg'
      }
    },
    services: [
      {id:1, name_ar:'استفسار', name_en:'Inquiry', type:'walkin', code_prefix:'A', kiosk_visible:true, is_active:true, availability_mode:'always', availability_weekday:null},
      {id:2, name_ar:'شكوى', name_en:'Complaint', type:'walkin', code_prefix:'C', kiosk_visible:true, is_active:true, availability_mode:'always', availability_weekday:null},
      {id:3, name_ar:'متابعة طلب', name_en:'Follow-up', type:'walkin', code_prefix:'F', kiosk_visible:true, is_active:true, availability_mode:'always', availability_weekday:null},
      {id:4, name_ar:'حجز لقاء مسؤول', name_en:'Book an appointment', type:'appointment', code_prefix:'M', kiosk_visible:true, is_active:true, availability_mode:'weekly_day', availability_weekday:4},
      {id:5, name_ar:'طلب لقاء', name_en:'Meeting request', type:'walkin', code_prefix:'L', kiosk_visible:true, is_active:true, availability_mode:'always', availability_weekday:null}
    ],
    users: [
      {id:1, username:'admin', password:'admin123', full_name:'Admin', role:'admin', is_active:true},
      {id:2, username:'emp01', password:'1234', full_name:'موظف 1', role:'counter', is_active:true}
    ],
    counters,
    counter_daily,
    sessions: [],
    tickets: [],
    ticket_calls: [],
    cases: [],
    feedback: [],
    feedback_windows: [],
    appointments: [],
    attachments: [],
    sequences: {}
  };
}
function loadDb(){
  if (db) return db;
  if (!fs.existsSync(DB_PATH)){
    fs.mkdirSync(path.dirname(DB_PATH), {recursive:true});
    fs.writeFileSync(DB_PATH, JSON.stringify(seedDb(), null, 2), 'utf8');
  }
  db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const changed = migrateDb();
  if (changed) saveDb();
  return db;
}

function migrateDb(){
  let changed = false;
  // Some older db.json files may not have a settings object at all.
  // Ensure settings exist to prevent runtime crashes in counter flows (close / auto-call / feedback window).
  if (!db.settings){
    db.settings = seedDb().settings;
    changed = true;
  }
  db.appointments = db.appointments || [];
  db.attachments = db.attachments || [];
  db.cases = db.cases || [];
  db.tickets = db.tickets || [];
  db.sequences = db.sequences || {};
  db.system = db.system || { version: '0.2.0', last_update_at: null, last_update_note: null };
  if (!db.system.version){ db.system.version = '0.2.0'; changed = true; }
  if (db.settings && !db.settings.appointments){
    db.settings.appointments = { enabled:true, weekday:4, start_time:"10:00", end_time:"12:00", slot_minutes:15 };
    changed = true;
  }
  if (db.settings && !db.settings.ui){
    db.settings.ui = { theme:'dark', kiosk_return_seconds:10, kiosk_auto_print:true, kiosk_printing_mode:'browser', kiosk_show_fullscreen_hint:true };
    changed = true;
  }

  // Display sound defaults (Arabic then English)
  if (db.settings && db.settings.ui && !db.settings.ui.sound){
    db.settings.ui.sound = {
      enabled: true,
      chime: true,
      chime_style: 'alarm', // alarm | airport | bell
      chime_volume: 0.85,
      speak_ar: true,
      speak_en: true,
      voice_gender_ar: 'auto', // auto | male | female
      voice_gender_en: 'auto', // auto | male | female
      phrase_ar: 'الرقم {ticket}، تفضل إلى {counter}',
      phrase_en: 'Ticket {ticket}, please go to {counter}'
    };
    changed = true;
  }

  // Ensure new sound fields exist
  if (db.settings && db.settings.ui && db.settings.ui.sound){
    if (db.settings.ui.sound.chime_style === undefined){ db.settings.ui.sound.chime_style = 'alarm'; changed = true; }
    if (db.settings.ui.sound.chime_volume === undefined){ db.settings.ui.sound.chime_volume = 0.85; changed = true; }
  }

  // Branding defaults
  if (db.settings && !db.settings.branding){
    db.settings.branding = {
      org_name_ar: 'وزارة التعليم',
      org_name_en: 'Ministry of Education',
      org_unit_ar: 'مكتب رعاية المستفيدين',
      org_unit_en: 'Beneficiary Care Office',
      location_ar: 'المملكة العربية السعودية',
      location_en: 'Kingdom of Saudi Arabia',
      logo_path: '/public/branding/logo.svg'
    };
    changed = true;
  }

  // Work hours defaults (kiosk + ticketing availability)
  if (db.settings && !db.settings.work_hours){
    db.settings.work_hours = {
      enabled: false,
      start_time: '07:30',
      end_time: '14:30',
      // 0=Sun .. 6=Sat (Saudi gov week usually Sun-Thu)
      days: [0,1,2,3,4]
    };
    changed = true;
  } else if (db.settings && db.settings.work_hours){
    if (db.settings.work_hours.enabled === undefined){ db.settings.work_hours.enabled = false; changed = true; }
    if (!db.settings.work_hours.start_time){ db.settings.work_hours.start_time = '07:30'; changed = true; }
    if (!db.settings.work_hours.end_time){ db.settings.work_hours.end_time = '14:30'; changed = true; }
    if (!Array.isArray(db.settings.work_hours.days) || !db.settings.work_hours.days.length){
      db.settings.work_hours.days = [0,1,2,3,4];
      changed = true;
    }
  }

  // Ensure kiosk auto fullscreen flag exists
  if (db.settings && db.settings.ui && db.settings.ui.kiosk_auto_fullscreen === undefined){
    db.settings.ui.kiosk_auto_fullscreen = true;
    changed = true;
  }

  // Service -> counter mapping (routing)
  if (db.settings && !db.settings.service_counter_map){
    db.settings.service_counter_map = {};
    changed = true;
  }

  if (Array.isArray(db.services)){
    db.services.forEach(s=>{
      if (s.name_en === undefined){ s.name_en = ''; changed = true; }
      if (s.availability_mode === undefined){ s.availability_mode = 'always'; changed = true; }
      if (s.availability_weekday === undefined) { s.availability_weekday = null; changed = true; }
      if (s.group === undefined){ s.group = ''; changed = true; }
    });

    // Add default service: "طلب لقاء" if missing
    const hasMeetingRequest = db.services.some(s => (s.name_ar || '').trim() === 'طلب لقاء');
    if (!hasMeetingRequest){
      const nextId = db.services.length ? Math.max(...db.services.map(x=>x.id||0)) + 1 : 1;
      db.services.push({
        id: nextId,
        name_ar: 'طلب لقاء',
        name_en: 'Meeting request',
        type: 'walkin',
        code_prefix: 'L',
        kiosk_visible: true,
        is_active: true,
        availability_mode: 'always',
        availability_weekday: null
      });
      changed = true;
    }

    // Ensure teacher categories exist (shown only when Beneficiary Type = Teacher)
    const teacherCats = [
      'الرخصة المهنية',
      'الأداء الوظيفي',
      'الترقيات',
      'متابعة الدوام',
      'تحسين مستوى',
      'نظام نور',
      'المراجعة الداخلية',
      'التشكيلات الإشرافية',
      'الإيفاد والابتعاث',
      'برنامج فرص',
      'ظروف خاصة',
      'التأمينات الاجتماعية',
      'الرواتب والبدلات',
      'نظام فارس',
      'الإجازات',
      'الشؤون القانونية',
      'الإعارة والنقل',
      'التعيين / عقود',
      'أخرى..'
    ];
    const existingTeacher = db.services.filter(s => (s.group||'')==='teacher').map(s => (s.name_ar||'').trim());
    const missing = teacherCats.filter(n => !existingTeacher.includes(n));
    if (missing.length){
      let nextId = db.services.length ? Math.max(...db.services.map(x=>x.id||0)) + 1 : 1;
      for (const name_ar of missing){
        db.services.push({
          id: nextId++,
          name_ar,
          name_en: '',
          type: 'walkin',
          code_prefix: 'T',
          kiosk_visible: false,
          is_active: true,
          availability_mode: 'always',
          availability_weekday: null,
          group: 'teacher'
        });
      }
      changed = true;
    }
    // Ensure Student (General Education) categories exist (Parent/Student → General)
    const studentCats = [
      {name_ar: "الأقسام التعليمية", icon: "users"},
      {name_ar: "الموهوبين", icon: "cap"},
      {name_ar: "التربية الخاصة", icon: "shield"},
      {name_ar: "إغناء القدرات والتحصيلي", icon: "chart"},
      {name_ar: "الشهادات الدراسية (أعوام محددة)", icon: "calendar"},
      {name_ar: "معادلة الشهادات (خريجي ثالث ثانوي)", icon: "scale"},
      {name_ar: "نظام نور", icon: "noor"}
    ];


    const staffCats = [
      { slug:'staff_promotions', ar:'ترقيات', en:'Promotions', fr:'Promotions', zh:'晋升', icon:'up' },
      { slug:'staff_leaves', ar:'الإجازات', en:'Leaves', fr:'Congés', zh:'休假', icon:'calendar' },
      { slug:'staff_finance', ar:'شؤون مالية', en:'Financial Affairs', fr:'Affaires financières', zh:'财务事务', icon:'wallet' },
      { slug:'staff_legal', ar:'القانونية', en:'Legal', fr:'Juridique', zh:'法律', icon:'scale' },
      { slug:'staff_masar', ar:'مسار', en:'Masar', fr:'Masar', zh:'Masar', icon:'chart' },
      { slug:'staff_scholarship', ar:'الإيفاد والابتعاث', en:'Secondment & Scholarship', fr:'Détachement & bourses', zh:'派遣与奖学金', icon:'plane' },
      { slug:'staff_faris', ar:'نظام فارس', en:'Faris System', fr:'Système Faris', zh:'Faris系统', icon:'faris' },
      { slug:'staff_volunteer', ar:'العمل التطوعي', en:'Volunteer Work', fr:'Bénévolat', zh:'志愿工作', icon:'users' },
      { slug:'staff_hr_dev', ar:'تطوير الموارد البشرية', en:'HR Development', fr:'Développement RH', zh:'人力资源发展', icon:'cap' },
      { slug:'staff_salaries', ar:'الرواتب والبدلات', en:'Salaries & Allowances', fr:'Salaires & allocations', zh:'薪资与津贴', icon:'wallet' },
      { slug:'staff_performance', ar:'الأداء الوظيفي', en:'Job Performance', fr:'Performance professionnelle', zh:'工作绩效', icon:'chart' },
      { slug:'staff_retirement', ar:'التقاعد', en:'Retirement', fr:'Retraite', zh:'退休', icon:'contract' },
      { slug:'staff_internal_audit', ar:'المراجعة الداخلية', en:'Internal Audit', fr:'Audit interne', zh:'内部审查', icon:'search' },
      { slug:'staff_gosi', ar:'التأمينات الاجتماعية', en:'Social Insurance', fr:'Assurance sociale', zh:'社会保险', icon:'shield' },
      { slug:'staff_assignment', ar:'التكليف / نقل / إعارة', en:'Assignment / Transfer / Secondment', fr:'Affectation / transfert / détachement', zh:'派遣/调动/借调', icon:'swap' },
      { slug:'staff_wages', ar:'بند الأجور والعمال', en:'Wages & Workers', fr:'Salaires & ouvriers', zh:'工资与工人', icon:'wallet' },
      { slug:'staff_attendance', ar:'متابعة الدوام', en:'Attendance Follow-up', fr:'Suivi de présence', zh:'考勤跟进', icon:'clock' },
      { slug:'staff_other', ar:'أخرى', en:'Other', fr:'Autre', zh:'其他', icon:'alert' }
    ];

    const existingStudent = db.services.filter(s => (s.group||" ").trim()==="student").map(s => (s.name_ar||" ").trim());
    const missingStudent = studentCats.filter(o => !existingStudent.includes((o.name_ar||" ").trim()));
    if (missingStudent.length){
      let nextId = db.services.length ? Math.max(...db.services.map(x=>x.id||0)) + 1 : 1;
      for (const o of missingStudent){
        db.services.push({
          id: nextId++,
          name_ar: o.name_ar,
          name_en: "",
          type: "walkin",
          code_prefix: "S",
          kiosk_visible: false,
          is_active: true,
          availability_mode: "always",
          availability_weekday: null,
          group: "student",
          icon: o.icon
        });
      }
      changed = true;
    }

  }


// Extend cases with additional workflow fields
if (Array.isArray(db.cases)){
  db.cases.forEach(c=>{
    if (c.category === undefined){ c.category = ''; changed = true; }
    if (c.priority === undefined){ c.priority = 'normal'; changed = true; }
    if (c.channel === undefined){ c.channel = 'walkin'; changed = true; }
    if (c.internal_notes === undefined){ c.internal_notes = ''; changed = true; }
    if (c.transfer_to === undefined){ c.transfer_to = ''; changed = true; }
    if (c.awaiting_from === undefined){ c.awaiting_from = ''; changed = true; }
    if (c.due_date === undefined){ c.due_date = ''; changed = true; }
    if (c.appointment_id === undefined){ c.appointment_id = null; changed = true; }
  });
}
  return changed;
}
function saveDb(){
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}


function safeUuid(){
  try { return require('crypto').randomUUID(); } catch(e){
    return 'id-' + Math.random().toString(16).slice(2) + '-' + Date.now();
  }
}

function getService(serviceId){
  return db.services.find(s=>s.id===Number(serviceId)) || null;
}

function ensureCase(ticket_id){
  let c = db.cases.find(x=>x.ticket_id===ticket_id);
  if (!c){
    const id = db.cases.length? Math.max(...db.cases.map(x=>x.id))+1:1;
    c = {
      id, ticket_id,
      summary:'', details:'', phone:'',
      outcome_code:'', not_resolved_reason:'',
      category:'', priority:'normal', channel:'walkin',
      internal_notes:'',
      transfer_to:'', awaiting_from:'', due_date:'',
      appointment_id: null,
      created_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    };
    db.cases.push(c);
  }
  c.category = c.category ?? '';
  c.priority = c.priority ?? 'normal';
  c.channel = c.channel ?? 'walkin';
  c.internal_notes = c.internal_notes ?? '';
  c.transfer_to = c.transfer_to ?? '';
  c.awaiting_from = c.awaiting_from ?? '';
  c.due_date = c.due_date ?? '';
  if (c.appointment_id === undefined) c.appointment_id = null;
  return c;
}

function listAttachments(ticket_id){
  return (db.attachments || []).filter(a=>a.ticket_id===ticket_id).sort((a,b)=> new Date(b.uploaded_at)-new Date(a.uploaded_at));
}

function nextAppointmentDate(fromDateStr, weekday){
  const base = new Date(fromDateStr + 'T00:00:00');
  const baseDow = base.getDay();
  let diff = (weekday - baseDow + 7) % 7;
  if (diff === 0) diff = 7;
  const d = new Date(base.getTime() + diff*24*3600*1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

function timeToMinutes(hhmm){
  const [h,m] = String(hhmm).split(':').map(x=>Number(x));
  return (h*60) + (m||0);
}
function minutesToTime(m){
  const h = String(Math.floor(m/60)).padStart(2,'0');
  const mm = String(m%60).padStart(2,'0');
  return `${h}:${mm}`;
}

function ensureSlotsForDate(dateStr){
  db.appointments = db.appointments || [];
  const cfg = db.settings.appointments || { start_time:'10:00', end_time:'12:00', slot_minutes:15 };
  const startM = timeToMinutes(cfg.start_time);
  const endM = timeToMinutes(cfg.end_time);
  const slotM = Number(cfg.slot_minutes)||15;

  const any = db.appointments.some(a=>a.date===dateStr);
  if (any) return;

  let cur = startM;
  while (cur + slotM <= endM){
    const id = (db.appointments.length? Math.max(...db.appointments.map(a=>a.id))+1:1);
    db.appointments.push({
      id,
      date: dateStr,
      start_time: minutesToTime(cur),
      end_time: minutesToTime(cur+slotM),
      status: 'available',
      booked_ticket_id: null,
      booked_by_user_id: null,
      booked_name: '',
      booked_phone: '',
      booked_national_id: '',
      booked_at: null
    });
    cur += slotM;
  }
}

function getAvailableSlotsForNextDay(){
  const wd = db.settings.appointments.weekday;
  const nextDate = nextAppointmentDate(getWorkDate(), wd);
  ensureSlotsForDate(nextDate);
  const slots = db.appointments
    .filter(a=>a.date===nextDate && a.status==='available')
    .sort((a,b)=> timeToMinutes(a.start_time)-timeToMinutes(b.start_time));
  return {date: nextDate, slots};
}

function dayOfWeek(dateStr){
  // dateStr: YYYY-MM-DD
  try{ return new Date(dateStr + 'T00:00:00').getDay(); }catch(e){ return null; }
}


async function requireCounterLogin(req,res,next){
  // Counter session is isolated from Admin session to avoid confusion when both are open.
  if (req.session.counter_user) return next();

  // If this request is for AJAX/JSON, do NOT redirect to HTML login (it breaks fetch parsing).
  const wantsJson = (() => {
    try{
      const a = String(req.headers['accept'] || '');
      const ct = String(req.headers['content-type'] || '');
      return a.includes('application/json') || ct.includes('application/json') || req.xhr;
    }catch(e){ return false; }
  })();

  const unauth = () => wantsJson
    ? res.status(401).json({ok:false, code:'unauth', msg:'انتهت الجلسة أو لا يوجد دخول'})
    : res.redirect('/counter/login');

  // Recovery: cookie may still point to an active counter session.
  try{
    const sid = req.session.counter_session_id;
    if (!sid) return unauth();
    await loadDb();
    const s = findSessionById(sid);
    if (!s || s.ended_at) return unauth();
    const u = (db.users||[]).find(x => String(x.id)===String(s.user_id));
    if (!u) return unauth();
    req.session.counter_user = {id: u.id, username: u.username, role: u.role};
    return next();
  }catch(e){
    return unauth();
  }
}
function requireAdmin(req,res,next){
  // Full admin (system manager) only
  if (!req.session.admin_user) return res.redirect('/admin/login');
  if (req.session.admin_user.role !== 'admin') return res.redirect('/admin/login');
  next();
}

function requireReportsAccess(req,res,next){
  // Admin + Supervisor can access reports
  if (!req.session.admin_user) return res.redirect('/admin/login');
  const r = String(req.session.admin_user.role || '');
  if (r !== 'admin' && r !== 'supervisor') return res.redirect('/admin/login');
  next();
}


function requireAnyAuth(req,res,next){
  if (req.session && (req.session.counter_user || req.session.admin_user)) return next();
  return res.status(401).send('Unauthorized');
}

// Printable instructions page (used by the Help modal "طباعة" / "تحميل PDF")
app.get('/help/instructions', requireAnyAuth, (req,res)=>{
  const roleQ = String(req.query.role || '').toLowerCase();
  const mode = String(req.query.mode || '');
  const role = (roleQ === 'counter' || roleQ === 'admin')
    ? roleQ
    : (req.session.counter_user ? 'counter' : 'admin');
  const roleLabel = (role === 'counter') ? 'شاشة الموظف' : 'لوحة الإدارة';
  res.render('help_instructions', { role, roleLabel, mode });
});

function getWorkDate(){ return todayStr(); }

function normalizeLang(v){
  const s = String(v || '').toLowerCase();
  if (s === 'en') return 'en';
  if (s === 'zh' || s === 'cn' || s === 'zh-cn' || s === 'zh_hans') return 'zh';
  return 'ar';
}

// --- CSV/PDF helpers ---
function csvEscape(v){
  const s = (v==null) ? '' : String(v);
  const needs = /[\n\r\,\"]/g.test(s);
  const out = s.replace(/\"/g,'""');
  return needs ? `"${out}"` : out;
}

function buildCsv(headers, rows){
  const lines = [];
  lines.push(headers.map(csvEscape).join(','));
  rows.forEach(r=> lines.push(r.map(csvEscape).join(',')));
  return lines.join('\n');
}

// Naive Arabic shaping for PDFKit (works for many UI strings). If the reshaper is not available,
// we fallback to raw text.
function arPdf(text){
  const s = String(text || '');
  if (!s) return '';
  if (!ArabicReshaper || !ArabicReshaper.reshape) return s;
  try{
    // Keep word order intact; PDFKit typically renders this as-is when reshaped.
    return ArabicReshaper.reshape(s);
  }catch(e){
    return s;
  }
}
function getKioskLang(req){
  // kiosk language can be driven by query (?lang=en) or by form hidden input
  return normalizeLang((req.body && req.body.lang) || (req.query && req.query.lang) || (req.session && req.session.kiosk_lang) || 'ar');
}

function getCounterDailyMap(workDate){
  // Default: all counters enabled unless explicitly disabled for the day.
  const map = new Map();
  (db.counters || []).forEach(c=> map.set(c.id, true));
  (db.counter_daily || []).filter(x=>x.work_date===workDate).forEach(x=>map.set(x.counter_id, x.enabled_today===true));
  return map;
}
function getActiveSessions(){
  const now = Date.now();
  const timeoutMs = 90*1000;
  return db.sessions.filter(s => s.status==='active' && s.counter_id!=null && (now - new Date(s.last_heartbeat).getTime()) < timeoutMs);
}
function availableCounters(workDate){
  const daily = getCounterDailyMap(workDate);
  const active = new Set(getActiveSessions().map(s=>s.counter_id));
  return db.counters
    .filter(c => c.is_active && daily.get(c.id)===true && active.has(c.id))
    .map(c => ({id:c.id, priority_order:c.priority_order, name:c.name}));
}

// User -> service permissions
function getAllowedServiceIdsForUser(user){
  if (!user) return null;
  // null/undefined/empty array means "all services"
  if (!Array.isArray(user.allowed_service_ids) || user.allowed_service_ids.length===0) return null;
  return user.allowed_service_ids.map(Number).filter(n=>Number.isFinite(n));
}
function userCanServeService(user, serviceId){
  const allowed = getAllowedServiceIdsForUser(user);
  if (!allowed) return true;
  return allowed.includes(Number(serviceId));
}
function getActiveSessionForCounter(counterId){
  return getActiveSessions().find(s=>String(s.counter_id)===String(counterId)) || null;
}
function counterCanServeService(counterId, serviceId){
  const ses = getActiveSessionForCounter(counterId);
  if (!ses) return false;
  const u = db.users.find(x=>String(x.id)===String(ses.user_id));
  return userCanServeService(u, serviceId);
}
function loadForCounter(counterId){
  const statuses = new Set(['ASSIGNED','CALLED','IN_SERVICE']);
  return db.tickets.filter(t => t.assigned_counter_id===counterId && statuses.has(t.status)).length;
}
function inServiceCount(counterId){
  return db.tickets.filter(t => t.assigned_counter_id===counterId && t.status==='IN_SERVICE').length;
}
function lastCallAt(counterId){
  const called = db.tickets.filter(t => t.assigned_counter_id===counterId && t.called_at);
  if (!called.length) return null;
  called.sort((a,b)=> new Date(a.called_at) - new Date(b.called_at));
  return called[0].called_at;
}
function chooseLeastLoaded(counters){
  if (!counters.length) return null;
  const rows = counters.map(c => ({
    counter_id: c.id,
    load: loadForCounter(c.id),
    in_service: inServiceCount(c.id),
    last_call_at: lastCallAt(c.id),
    priority_order: c.priority_order
  }));
  rows.sort((a,b)=>{
    if (a.load!==b.load) return a.load-b.load;
    if (a.in_service!==b.in_service) return a.in_service-b.in_service;
    const al = a.last_call_at ? new Date(a.last_call_at).getTime() : 0;
    const bl = b.last_call_at ? new Date(b.last_call_at).getTime() : 0;
    if (al!==bl) return al-bl;
    return a.priority_order-b.priority_order;
  });
  return rows[0].counter_id;
}
function nextSequence(workDate, serviceId){
  if (!db.sequences[workDate]) db.sequences[workDate] = {};
  if (!db.sequences[workDate][serviceId]) db.sequences[workDate][serviceId] = 0;
  db.sequences[workDate][serviceId] += 1;
  return db.sequences[workDate][serviceId];
}
function pad3(n){ return String(n).padStart(3,'0'); }
function buildTicketCode(service, seq){
  const prefix = service.code_prefix || 'T';
  return `${prefix}-${pad3(seq)}`;
}
function serviceAvailableNow(service, workDate){
  if (!service.is_active) return false;
  if (!service.kiosk_visible) return false;
  if (service.availability_mode === 'always') return true;
  if (service.availability_mode === 'weekly_day'){
    const dow = dayOfWeek0Sun(workDate);
    const wd = (service.availability_weekday ?? db.settings.appointments.weekday);
    return dow === wd;
  }
  return true;
}
function assignUnassignedTickets(){
  const workDate = getWorkDate();
  const countersAll = availableCounters(workDate);
  if (!countersAll.length) return;
  const unassigned = db.tickets.filter(t => (t.assigned_counter_id==null) && t.status==='NEW');
  if (!unassigned.length) return;
  unassigned.sort((a,b)=> new Date(a.created_at)-new Date(b.created_at));
  for (const t of unassigned){
    // Only assign to counters whose active user can serve this ticket's service.
    const eligible = countersAll.filter(c=> counterCanServeService(c.id, t.service_id));
    if (!eligible.length) continue; // leave in NEW until an eligible counter is active
    const cId = chooseLeastLoaded(eligible);
    if (!cId) break;
    t.assigned_counter_id = cId;
    t.status = 'ASSIGNED';
    t.assigned_at = new Date().toISOString();
  }
}
function findSessionById(sessionId){
  return db.sessions.find(s=>String(s.id)===String(sessionId));
}
function findTicketById(ticketId){
  return (db.tickets||[]).find(t=>String(t.id)===String(ticketId));
}
function userHoldsCounter(userId, counterId){
  // Be tolerant to number/string differences (some session stores stringify ids)
  return !!db.sessions.find(x=>x.status==='active' && String(x.user_id)===String(userId) && String(x.counter_id)===String(counterId));
}
function createFeedbackWindow(ticket, counterId, userId){
  const now = new Date();
  const expires = new Date(now.getTime() + db.settings.feedback_window_seconds*1000);
  db.feedback_windows.push({
    ticket_id: ticket.id,
    ticket_code: ticket.ticket_code,
    counter_id: counterId,
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    consumed: false
  });
}
function getCurrentFeedbackWindow(){
  const now = Date.now();
  const windows = db.feedback_windows
    .filter(w => !w.consumed && (new Date(w.expires_at).getTime() > now));
  // FIFO: show oldest pending rating first
  windows.sort((a,b)=> new Date(a.created_at) - new Date(b.created_at));
  return windows[0] || null;
}

function getCurrentFeedbackWindowFor(counterId){
  const mode = (db.settings && db.settings.feedback_mode) ? db.settings.feedback_mode : 'shared';
  const now = Date.now();
  let windows = db.feedback_windows
    .filter(w => !w.consumed && (new Date(w.expires_at).getTime() > now));
  if (mode === 'per_counter' && counterId){
    windows = windows.filter(w => String(w.counter_id)===String(counterId));
  }
  windows.sort((a,b)=> new Date(a.created_at) - new Date(b.created_at));
  return windows[0] || null;
}

const autoCallTimers = Object.create(null);
function clearAutoCall(counterId){
  const k = String(counterId);
  const t = autoCallTimers[k];
  if (t) { try{ clearTimeout(t); }catch(e){} }
  delete autoCallTimers[k];
}

function scheduleAutoCall(counterId){
  const restDefault = db.settings.rest_seconds_default;
  const restMin = db.settings.rest_seconds_min;
  const restMax = db.settings.rest_seconds_max;

  // Per-counter overrides are configured by Admin
  const ov = (db.settings && db.settings.counter_overrides && db.settings.counter_overrides[String(counterId)]) ? db.settings.counter_overrides[String(counterId)] : {};
  const autoEnabled = (ov.auto_call_enabled == null) ? !!db.settings.auto_call_enabled : !!ov.auto_call_enabled;
  const rest = clampInt(ov.rest_seconds != null ? ov.rest_seconds : restDefault, restMin, restMax);

  clearAutoCall(counterId);
  if(!autoEnabled) return;
  if (inServiceCount(counterId) > 0) return;

  autoCallTimers[String(counterId)] = setTimeout(()=>{
    tryCallNext(counterId, {auto:true});
  }, rest * 1000);
}

function callNextInternal(counterId, userId, isAuto=false){
  const user = db.users.find(u=>String(u.id)===String(userId));
  // 1) Tickets already routed/assigned to this counter
  // IMPORTANT: Older/legacy records may keep status='NEW' even when assigned_counter_id is set.
  // To avoid "استدعاء التالي" failing while tickets exist, we accept both NEW and ASSIGNED here.
  // Use string-safe comparison because ids may be stored as number or string depending on older data/imports.
  let candidates = db.tickets.filter(t=>
    String(t.assigned_counter_id)===String(counterId)
    && (t.status==='ASSIGNED' || t.status==='NEW')
    && userCanServeService(user, t.service_id)
  );
  candidates.sort((a,b)=> new Date(a.created_at) - new Date(b.created_at));
  let t = candidates[0];

  // Normalize legacy state
  if (t && t.status==='NEW'){
    t.status='ASSIGNED';
    if (!t.assigned_at) t.assigned_at = new Date().toISOString();
  }

  // 2) Otherwise, pull from the shared queue (NEW / unassigned)
  if (!t){
    const shared = db.tickets.filter(x=>
      x.status==='NEW'
      && (!x.assigned_counter_id || String(x.assigned_counter_id)===String(counterId))
      && userCanServeService(user, x.service_id)
    );
    shared.sort((a,b)=> new Date(a.created_at) - new Date(b.created_at));
    t = shared[0];
    if (!t) return null;
    t.assigned_counter_id = counterId;
    t.assigned_at = new Date().toISOString();
    t.status = 'ASSIGNED';
  }

  t.status = 'CALLED';
  t.called_at = new Date().toISOString();
  const prevCalls = db.ticket_calls.filter(c=>c.ticket_id===t.id && c.counter_id===counterId && c.result==='called');
  const round = prevCalls.length + 1;
  const nextId = db.ticket_calls.length ? Math.max(...db.ticket_calls.map(x=>x.id))+1 : 1;
  db.ticket_calls.push({
    id: nextId,
    ticket_id: t.id,
    counter_id: counterId,
    user_id: userId,
    call_round: round,
    called_at: t.called_at,
    result: 'called',
    auto: !!isAuto
  });
  return {ticket_id: t.id, ticket_code: t.ticket_code, call_round: round};
}

// Routes
app.get('/', (req,res)=> res.redirect('/kiosk'));

// QR as PNG (for kiosk ticket card scanning)
app.get('/api/qr.png', async (req,res)=>{
  try{
    const text = (req.query.text || '').toString();
    if (!text) return res.status(400).send('missing text');
    const buf = await QRCode.toBuffer(text, { type: 'png', margin: 1, scale: 6, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  }catch(e){
    res.status(500).send('qr error');
  }
});

// Kiosk
app.get('/kiosk', (req,res)=>{
  loadDb();
  const workDate = getWorkDate();
  const lang = getKioskLang(req);
  req.session.kiosk_lang = lang;
  const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
  const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};

  // Work hours gate
  if (!isWithinWorkHours(db.settings)){
    const now = tzParts(APP_TZ);
    const wh = (db.settings && db.settings.work_hours) ? db.settings.work_hours : {enabled:false,start_time:'',end_time:''};
    return res.render('kiosk_closed', { lang, ui, branding, work_hours: wh, now });
  }
  const services = db.services.filter(s=> (s.group||'')!=='teacher' (s.group||'')!=='teacher'(s.group||'')!=='teacher' (s.group||'')!=='student' && serviceAvailableNow(s, workDate));
  const teacher_services = db.services.filter(s=> (s.group||'')==='teacher' && !!s.is_active);
  const step = (req.query.step || '').toString();
  const student_services = db.services.filter(s=> (s.group||" ").trim()==="student" && !!s.is_active);
  const staff_services = db.services.filter(s=> (s.group||'').trim()==='staff' && !!s.is_active);
  // Default QR taken from the sample provided by the user (Google Maps location).
  const STUDENT_UNI_QR_DEFAULT = 'https://www.google.com/maps/place/%D9%88%D8%B2%D8%A7%D8%B1%D8%A9+%D8%A7%D9%84%D8%AA%D8%B9%D9%84%D9%8A%D9%85%E2%80%AD/@24.6624422,46.6884679,17z/data=!4m9!1m2!2m1!1z2YjZg9in2YTYqSDYp9mE2KrYudmE2YrZhSDYp9mE2KzYp9mF2LnZig!3m5!1s0x3e2f05f5dcd9f36d:0x939254fa8dded8a7!8m2!3d24.6618582!4d46.6851764!16s%2Fg%2F11h_w1vy9k!5m1!1e4?entry=ttu';
  const student_university = (ui && ui.student_university) ? ui.student_university : {enabled:true, qr_text:STUDENT_UNI_QR_DEFAULT, message_ar:"", message_en:"", message_fr:"", message_zh:""};
  // If enabled but QR text is empty, use the default so the QR is always shown.
  try{
    if (student_university && student_university.enabled && !String(student_university.qr_text||'').trim()){
      student_university.qr_text = STUDENT_UNI_QR_DEFAULT;
    }
  }catch(e){}
  res.render('kiosk', { services, teacher_services, workDate, lang, step, ui, branding , staff_services});
});

app.post('/kiosk/issue', (req,res)=>{
  loadDb();
  const lang = getKioskLang(req);
  req.session.kiosk_lang = lang;

  // Work hours gate (server-side)
  if (!isWithinWorkHours(db.settings)){
    const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
    const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
    const now = tzParts(APP_TZ);
    const wh = (db.settings && db.settings.work_hours) ? db.settings.work_hours : {enabled:false,start_time:'',end_time:''};
    return res.status(403).render('kiosk_closed', { lang, ui, branding, work_hours: wh, now });
  }

  const serviceId = Number(req.body.service_id);
  const workDate = getWorkDate();
  const service = db.services.find(s=>s.id===serviceId);
  if (!service) return res.status(400).send(lang==='en' ? 'Service not found' : 'خدمة غير موجودة');
  // Teacher categories are intentionally hidden from the normal list (kiosk_visible=false)
  // but are allowed when beneficiary_type === 'teacher'.
  const isTeacherService = (service.group||'')==='teacher';
  const isStudentService = (service.group||" ").trim()==="student";
  const student_track = (req.body.student_track || "").toString().trim();


  const national_id = (req.body.national_id || '').toString().trim();
  const phone = (req.body.phone || '').toString().trim();
  const full_name = (req.body.full_name || '').toString().trim();
  const beneficiary_type = (req.body.beneficiary_type || '').toString().trim();
  const has_previous = String(req.body.has_previous || 'false') === 'true';
  const previous_ref = (req.body.previous_ref || '').toString().trim();

  if (!full_name || full_name.split(/\s+/).filter(Boolean).length < 3) return res.status(400).send(lang==='en' ? 'Full name (three parts) is required' : 'الاسم الثلاثي مطلوب');
  if (!national_id || national_id.length < 8) return res.status(400).send(lang==='en' ? 'National ID is required' : 'رقم الهوية مطلوب');
  // phone required for kiosk intake
  if (!phone || (phone.replace(/\D/g,'').length < 8)) return res.status(400).send(lang==='en' ? 'Phone number is required' : 'رقم الجوال مطلوب');
  if (!beneficiary_type) return res.status(400).send(lang==='en' ? 'Beneficiary type is required' : 'اختر فئة المستفيد');

  if (isStudentService){
    if (beneficiary_type !== "parent_student" || student_track !== "general"){
      return res.status(400).send(lang==="en" ? "Invalid service for this beneficiary type" : "هذه الخدمة مخصصة لقسم الطالب (تعليم عام) فقط");
    }
  }


  if (isStaffService && beneficiary_type !== 'staff'){
    return res.status(400).send(lang==='en' ? 'Invalid service for this beneficiary type' : 'هذه الخدمة مخصصة لفئة الإداري فقط');
  }

  if (isTeacherService && beneficiary_type !== 'teacher'){
    return res.status(400).send(lang==='en' ? 'Invalid service for this beneficiary type' : 'هذه الخدمة مخصصة لفئة المعلم فقط');
  }

  if (!isTeacherService){
    if (!serviceAvailableNow(service, workDate)) return res.status(400).send(lang==='en' ? 'Service not available today' : 'الخدمة غير متاحة اليوم');
  } else {
    if (!service.is_active) return res.status(400).send(lang==='en' ? 'Service not available' : 'الخدمة غير متاحة');
  }

  const requirePrev = (serviceId === 3) || has_previous;
  if (requirePrev && !previous_ref) return res.status(400).send(lang==='en' ? 'Previous request number is required' : 'رقم الطلب السابق مطلوب');

  // Optional routing: admin can map a service to a specific counter.
  // Default: do not pre-assign tickets; counters pull next from the shared queue.
  const map = (db.settings && db.settings.service_counter_map) ? db.settings.service_counter_map : {};
  const mappedCounter = map[String(serviceId)] ? Number(map[String(serviceId)]) : null;
  const daily = getCounterDailyMap(workDate);
  const active = new Set(getActiveSessions().map(s=>s.counter_id));
  const chosen = (mappedCounter && db.counters.find(c=>c.id===mappedCounter && c.is_active) && daily.get(mappedCounter)===true && active.has(mappedCounter))
    ? mappedCounter
    : null;

  const seq = nextSequence(workDate, serviceId);
  const ticketCode = buildTicketCode(service, seq);
  const id = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : require('crypto').randomUUID();

  const ticket = {
    id,
    ticket_code: ticketCode,
    service_id: serviceId,
    service_name: (lang==='en' ? (service.name_en || service.name_ar) : (lang==='fr' ? (service.name_fr || service.name_en || service.name_ar) : (lang==='zh' ? (service.name_zh || service.name_en || service.name_ar) : service.name_ar))),
    service_name_ar: service.name_ar,
    service_name_en: service.name_en || service.name_ar,
    lang,

    beneficiary: {
      full_name,
      national_id,
      phone,
      beneficiary_type,
      has_previous,
      previous_ref
    },

    national_id,
    phone,
    full_name,
    beneficiary_type,
    has_previous,
    previous_ref,

    assigned_counter_id: chosen || null,
    status: chosen ? 'ASSIGNED' : 'NEW',
    created_at: new Date().toISOString(),
    assigned_at: chosen ? new Date().toISOString() : null,
    called_at: null,
    in_service_at: null,
    closed_at: null,
    served_by_user_id: null,
    closed_by_user_id: null,

    barcode_value: `${ticketCode}|${id.slice(0,8)}`,
    qr_value: `TICKET:${id}`,

    print_status: 'ok'
  };

  // Friendly issue date/time for printing and UI
  const issueFmt = formatIssueDateTime(ticket.created_at, APP_TZ);
  ticket.issued_date = issueFmt.date;
  ticket.issued_time = issueFmt.time;

  db.tickets.push(ticket);
  saveDb();
  const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
  const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
  res.render('kiosk_ticket', { ticket, lang, ui, branding });
});


// Display
app.get('/display', (req,res)=>{
  loadDb();
  const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
  const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
  res.render('display', { branding, ui });
});

app.get('/display/counter/:id', (req,res)=>{
  loadDb();
  const counterId = Number(req.params.id);
  const counter = db.counters.find(c=>c.id===counterId);
  if (!counter) return res.status(404).send('Counter not found');
  const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
  const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
  res.render('display_counter', { counter, branding, ui });
});

app.get('/api/display/board', (req,res)=>{
  loadDb();
  const workDate = getWorkDate();
  const daily = getCounterDailyMap(workDate);
  const counters = db.counters
    .filter(c=>c.is_active && daily.get(c.id)===true)
    .sort((a,b)=>a.priority_order-b.priority_order)
    .map(c=>{
      const lastCalled = db.tickets
        .filter(t=>t.assigned_counter_id===c.id && t.status==='CALLED')
        .sort((a,b)=> new Date(b.called_at) - new Date(a.called_at))[0] || null;
      const inService = db.tickets
        .filter(t=>t.assigned_counter_id===c.id && t.status==='IN_SERVICE')
        .sort((a,b)=> new Date(b.in_service_at) - new Date(a.in_service_at))[0] || null;
      return {
        id: c.id,
        name: c.name,
        current: inService ? {ticket_code: inService.ticket_code, state:'قيد الخدمة'} :
                 lastCalled ? {ticket_code: lastCalled.ticket_code, state:'الآن'} :
                 null
      };
    });

  const recentCalls = db.ticket_calls
    .slice()
    .sort((a,b)=> new Date(b.called_at) - new Date(a.called_at))
    .slice(0,10)
    .map(call=>{
      const t = db.tickets.find(x=>x.id===call.ticket_id);
      const counter = db.counters.find(x=>x.id===call.counter_id);
      return {
        id: call.id,
        ticket_code: t ? t.ticket_code : '-',
        counter_name: counter ? counter.name : `كونتر ${call.counter_id}`,
        called_at: call.called_at,
        round: call.call_round
      };
    });

  const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
  res.json({ok:true, counters, recentCalls, ui: { theme: ui.theme || 'dark', sound: ui.sound || null } });
});

app.get('/api/display/counter/:id', (req,res)=>{
  loadDb();
  const counterId = Number(req.params.id);
  const workDate = getWorkDate();
  const daily = getCounterDailyMap(workDate);
  const counter = db.counters.find(c=>c.id===counterId);
  if (!counter || !counter.is_active || daily.get(counterId)!==true){
    return res.json({ok:true, counter:null, current:null});
  }
  const inService = db.tickets
    .filter(t=>t.assigned_counter_id===counterId && t.status==='IN_SERVICE')
    .sort((a,b)=> new Date(b.in_service_at) - new Date(a.in_service_at))[0] || null;
  const lastCalled = db.tickets
    .filter(t=>t.assigned_counter_id===counterId && t.status==='CALLED')
    .sort((a,b)=> new Date(b.called_at) - new Date(a.called_at))[0] || null;
  const current = inService ? {ticket_code: inService.ticket_code, state:'IN_SERVICE'} :
                 lastCalled ? {ticket_code: lastCalled.ticket_code, state:'CALLED'} : null;
  res.json({ok:true, counter:{id:counter.id, name:counter.name}, current});
});

// Counter login
app.get('/counter/login', (req,res)=>{
  loadDb();
  const closed = (String(req.query.closed||'') === '1') || (req.session.counter_closed_flash === 1);
  req.session.counter_closed_flash = 0;
  res.set('Cache-Control', 'no-store');
  res.render('counter_login', { error:null, closed });
});

app.post('/counter/login', (req,res)=>{
  loadDb();
  const {username, password} = req.body;
  const user = db.users.find(u=>u.username===username && u.password===password && u.is_active && u.role==='counter');
  if (!user) return res.render('counter_login', { error:'بيانات الدخول غير صحيحة', closed:false });

  // end previous sessions for this user
  db.sessions.forEach(s=>{
    if (s.user_id===user.id && s.status==='active'){
      s.status='ended';
      s.ended_at=new Date().toISOString();
    }
  });

  // counter selection:
  // - if user has fixed counter_id, try to reserve it
  // - otherwise auto-assign by priority
  const workDate = getWorkDate();
  const daily = getCounterDailyMap(workDate);
  const held = new Set(getActiveSessions().map(s=>s.counter_id));
  let candidate = null;
  const fixedId = (user.fixed_counter_id!=null && String(user.fixed_counter_id).trim()!=='') ? Number(user.fixed_counter_id) : null;
  if (fixedId && Number.isFinite(fixedId)){
    const c = db.counters.find(x=>x.id===fixedId);
    if (c && c.is_active && daily.get(fixedId)===true && !held.has(fixedId)){
      candidate = c;
    }
  }
  if (!candidate){
    candidate = db.counters
      .filter(c=>c.is_active && daily.get(c.id)===true && !held.has(c.id))
      .sort((a,b)=>a.priority_order-b.priority_order)[0] || null;
  }

  const newSessionId = db.sessions.length ? Math.max(...db.sessions.map(s=>s.id))+1 : 1;
  const sess = {
    id: newSessionId,
    user_id: user.id,
    counter_id: candidate ? candidate.id : null,
    status: 'active',
    started_at: new Date().toISOString(),
    ended_at: null,
    last_heartbeat: new Date().toISOString(),
    auto_call_override: null,
    rest_seconds_override: null
  };
  db.sessions.push(sess);
  assignUnassignedTickets();
  saveDb();

  req.session.counter_user = {id:user.id, username:user.username, full_name:user.full_name, role:user.role};
  req.session.counter_session_id = sess.id;
  res.redirect('/counter');
});

app.get('/counter/logout', (req,res)=>{
  loadDb();
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  if (s){
    s.status='ended';
    s.ended_at=new Date().toISOString();
  }
  saveDb();
  // Logout counter without killing Admin session (if open in another tab)
  req.session.counter_user = null;
  req.session.counter_session_id = null;
  req.session.counter_closed_flash = 1;
  res.redirect('/counter/login?closed=1&ts=' + Date.now());
});

app.get('/counter', requireCounterLogin, (req,res)=>{
  loadDb();
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  if (!s) return res.redirect('/counter/login');
  if (!s.counter_id) return res.render('counter_standby', { user:req.session.counter_user });

  assignUnassignedTickets();
  saveDb();

  const counter = db.counters.find(c=>c.id===s.counter_id);

  const currentCalled = db.tickets
    .filter(t=>String(t.assigned_counter_id)===String(s.counter_id) && t.status==='CALLED')
    .sort((a,b)=> new Date(b.called_at) - new Date(a.called_at))[0] || null;

  const currentInService = db.tickets
    .filter(t=>String(t.assigned_counter_id)===String(s.counter_id) && t.status==='IN_SERVICE')
    .sort((a,b)=> new Date(b.in_service_at) - new Date(a.in_service_at))[0] || null;

  const queue = db.tickets
    .filter(t=>String(t.assigned_counter_id)===String(s.counter_id) && ['ASSIGNED','CALLED','IN_SERVICE'].includes(t.status))
    .sort((a,b)=> new Date(a.created_at)-new Date(b.created_at));

  const skipped = db.tickets
    .filter(t=>String(t.assigned_counter_id)===String(s.counter_id) && t.status==='SKIPPED')
    .sort((a,b)=> new Date(b.skipped_at||b.called_at||b.created_at) - new Date(a.skipped_at||a.called_at||a.created_at));

  const counters = (db.counters||[]).filter(c=>c && c.is_active!==false);
  // Show a persistent "closed" confirmation once after returning to the counter screen.
  // This is server-side (session) so it works even if the page navigated away (e.g., to evaluation)
  // or if client-side JS/storage is blocked.
  const closedFlag = (String(req.query.closed||'') === '1') || (req.session && req.session.counter_closed_flash === 1);
  if (req.session) req.session.counter_closed_flash = 0;
  res.render('counter', { user:req.session.counter_user, session:s, counter, counters, currentCalled, currentInService, queue, skipped, settings: db.settings, closedFlag });
});

// Transfer ticket to another counter (keeps same number)
app.post('/counter/transfer', requireCounterLogin, (req,res)=>{
  loadDb();
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  if (!s || !s.counter_id) return res.status(400).json({ok:false, msg:'جلسة غير صالحة'});
  const {ticket_id, target_counter_id, note} = req.body;
  const t = findTicketById(ticket_id);
  if (!t) return res.status(400).json({ok:false, msg:'التذكرة غير موجودة'});
  // Allow transfer in case the user opened multiple counter tabs in the same browser session.
  // In that scenario, the session's counter_id may be overwritten by another tab, while the
  // ticket is still served/called by the same counter user.
  const sameCounter = String(t.assigned_counter_id) === String(s.counter_id);
  const sameUser = (t.served_by_user_id != null) && (String(t.served_by_user_id) === String(req.session.counter_user.id));
  if (!sameCounter && !sameUser) {
    return res.status(400).json({ok:false, msg:'تذكرة غير مرتبطة بهذا الكونتر'});
  }
  const toId = Number(target_counter_id);
  if (!toId || toId===s.counter_id) return res.status(400).json({ok:false, msg:'اختر كونتر مختلف'});
  const target = (db.counters||[]).find(c=>c.id===toId && c.is_active!==false);
  if (!target) return res.status(400).json({ok:false, msg:'الكونتر الهدف غير موجود'});

  // Reset state and re-queue at target
  t.assigned_counter_id = toId;
  t.status = 'ASSIGNED';
  t.called_at = null;
  t.in_service_at = null;
  t.served_by_user_id = null;
  t.transferred_at = new Date().toISOString();
  t.transferred_from_counter_id = s.counter_id;
  t.transfer_note = (note && String(note).trim()) ? String(note).trim().slice(0,200) : '';

  if (!Array.isArray(db.ticket_transfers)) db.ticket_transfers = [];
  const nextId = db.ticket_transfers.length ? Math.max(...db.ticket_transfers.map(x=>x.id||0))+1 : 1;
  db.ticket_transfers.push({
    id: nextId,
    ticket_id: t.id,
    ticket_code: t.ticket_code,
    from_counter_id: s.counter_id,
    to_counter_id: toId,
    user_id: req.session.counter_user.id,
    note: t.transfer_note,
    at: t.transferred_at
  });

  saveDb();
  res.json({ok:true});
});

app.post('/counter/heartbeat', requireCounterLogin, (req,res)=>{
  loadDb();
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  if (s){
    s.last_heartbeat = new Date().toISOString();
    saveDb();
  }
  res.json({ok:true});
});

app.post('/counter/next', requireCounterLogin, (req,res)=>{
  loadDb();
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  if (!s || !s.counter_id) return res.status(400).json({ok:false, msg:'جلسة الكونتر غير صالحة.'});
  // Always trust the active counter session as the source of truth.
  // This prevents "غير مصرح" when admin and counter pages are open in the same browser.
  const sessionUser = db.users.find(x=>String(x.id)===String(s.user_id));
  if (sessionUser){ req.session.counter_user = sessionUser; }
  if (!sessionUser){
    return res.status(403).json({ok:false, msg:'غير مصرح.'});
  }
  // If the session was ended for any reason, do not allow calling
  if (s.status !== 'active'){
    return res.status(400).json({ok:false, msg:'جلسة الكونتر منتهية. أعد تسجيل الدخول.'});
  }
  // No extra guard is needed here; the session itself is authoritative.

  const workDate = getWorkDate();
  const daily = getCounterDailyMap(workDate);
  if (daily.get(s.counter_id) !== true){
    return res.status(400).json({ok:false, code:'counter_disabled', msg:'الكونتر غير مفعل اليوم من لوحة المدير.'});
  }

  const before = db.tickets.filter(t => (t.status==='ASSIGNED' && String(t.assigned_counter_id)===String(s.counter_id)) || (t.status==='NEW' && !t.assigned_counter_id)).length;
  const called = callNextInternal(s.counter_id, req.session.counter_user.id, false);
  saveDb();

  if (!called){
    const totalQueue = db.tickets.filter(t => (t.status==='NEW' || t.status==='ASSIGNED')).length;
    const eligibleNow = db.tickets.filter(t => (t.status==='ASSIGNED' && String(t.assigned_counter_id)===String(s.counter_id)) || (t.status==='NEW' && !t.assigned_counter_id)).length;
    const msg = (totalQueue===0 || (before===0 && eligibleNow===0))
      ? 'لا توجد تذاكر في الطابور الآن.'
      : 'لا توجد تذاكر متاحة لهذا الكونتر الآن (تحقق من توزيع الخدمات/الكونترات).';
    return res.status(200).json({ok:false, code:'no_ticket', msg});
  }

  res.json({ok:true, called});
});



app.post('/counter/start', requireCounterLogin, (req,res)=>{
  loadDb();
  const {ticket_id} = req.body;
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  const t = findTicketById(ticket_id);

  if (!s || !s.counter_id){
    return res.status(400).json({ok:false, code:'no_session', msg:'تعذر بدء الخدمة: لا توجد جلسة كونتر نشطة.'});
  }
  if (!t){
    return res.status(400).json({ok:false, code:'ticket_not_found', msg:'تعذر بدء الخدمة: التذكرة غير موجودة.'});
  }
  if (String(t.assigned_counter_id) !== String(s.counter_id)){
    return res.status(400).json({ok:false, code:'wrong_counter', msg:'تعذر بدء الخدمة: هذه التذكرة ليست على هذا الكونتر.'});
  }
  if (!['CALLED','ASSIGNED'].includes(t.status)){
    return res.status(400).json({ok:false, code:'bad_status', msg:'تعذر بدء الخدمة: يجب أن تكون حالة التذكرة (منادى) أولاً.', status:t.status});
  }

  t.status = 'IN_SERVICE';
  t.in_service_at = new Date().toISOString();
  t.served_by_user_id = req.session.counter_user.id;
  saveDb();
  res.json({ok:true});
});

app.post('/counter/no_show', requireCounterLogin, (req,res)=>{
  loadDb();
  const {ticket_id} = req.body;
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  const t = findTicketById(ticket_id);
  if (!s || !s.counter_id || !t) return res.status(400).json({ok:false});
  // "no_show" here means: re-call (manual). We no longer auto-cancel after N calls.
  const max = db.settings.no_show_max_rounds || 3;
  const calls = db.ticket_calls.filter(c=>c.ticket_id===ticket_id && c.counter_id===s.counter_id && c.result==='called');
  const nextId = db.ticket_calls.length ? Math.max(...db.ticket_calls.map(x=>x.id))+1 : 1;

  t.status='CALLED';
  t.called_at=new Date().toISOString();
  t.called_round = (t.called_round || 0) + 1;
  db.ticket_calls.push({id: nextId, ticket_id: t.id, counter_id: s.counter_id, user_id: req.session.counter_user.id, call_round: calls.length+1, called_at: t.called_at, result:'called'});
  saveDb();
  res.json({ok:true, status:t.status, call_round: calls.length+1, warn: (calls.length+1)>=max});
});

// Manual skip (Park ticket without deleting it; keeps number & beneficiary data)
app.post('/counter/skip', requireCounterLogin, (req,res)=>{
  loadDb();
  const {ticket_id, reason} = req.body;
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  const t = findTicketById(ticket_id);
  if (!s || !s.counter_id || !t) return res.status(400).json({ok:false});
  if (String(t.assigned_counter_id) !== String(s.counter_id)) return res.status(400).json({ok:false});
  if (!['CALLED','ASSIGNED','IN_SERVICE'].includes(t.status)) return res.status(400).json({ok:false, msg:'الحالة الحالية لا تسمح بالتجاوز.'});

  t.status = 'SKIPPED';
  t.skipped_at = new Date().toISOString();
  t.skip_reason = (reason && String(reason).trim()) ? String(reason).trim().slice(0,200) : '';

  const nextId = db.ticket_calls.length ? Math.max(...db.ticket_calls.map(x=>x.id))+1 : 1;
  db.ticket_calls.push({id: nextId, ticket_id: t.id, counter_id: s.counter_id, user_id: req.session.counter_user.id, call_round: (t.called_round||0), called_at: new Date().toISOString(), result:'skipped'});

  saveDb();
  res.json({ok:true, status:t.status});
});

app.post('/counter/close', requireCounterLogin, (req,res)=>{
  loadDb();
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  if (!s || !s.counter_id) return res.status(400).json({ok:false});
  const {
    ticket_id,
    outcome_status,
    summary,
    details,
    phone,
    not_resolved_reason,
    appointment_slot_id,
    // optional case fields (saved on close for convenience)
    category, priority, channel, internal_notes, transfer_to, awaiting_from, due_date
  } = req.body;

  // NOTE: ticket ids may arrive as strings from the browser <select>.
  // Our db may store ids as numbers. Always compare as strings to avoid false "not found".
  const ticketIdStr = String(ticket_id ?? '');
  const t = db.tickets.find(x=>String(x.id)===ticketIdStr);
  if (!t) return res.status(400).json({ok:false, msg:'التذكرة غير موجودة'});
  // Same guard logic as transfer: allow if the same counter user is the one serving the ticket
  // (useful when multiple counter tabs are open in the same browser session).
  const closeSameCounter = String(t.assigned_counter_id) === String(s.counter_id);
  const closeSameUser = (t.served_by_user_id != null) && (String(t.served_by_user_id) === String(req.session.counter_user.id));
  if (!closeSameCounter && !closeSameUser) {
    return res.status(400).json({ok:false, msg:'تذكرة غير مرتبطة بهذا الكونتر'});
  }
  if (!['IN_SERVICE','CALLED'].includes(t.status)) return res.status(400).json({ok:false, msg:'حالة التذكرة لا تسمح بالإغلاق'});

  const missing = [];
  if (!summary || !String(summary).trim()) missing.push('summary');
  // If not resolved, require reason
  if (String(outcome_status) === 'CLOSED_NOT_RESOLVED' && (!not_resolved_reason || !String(not_resolved_reason).trim())) missing.push('not_resolved_reason');
  // If awaiting follow-up, require due_date
  if (String(outcome_status) === 'CLOSED_AWAITING' && (!due_date || !String(due_date).trim())) missing.push('due_date');

  if (missing.length){
    return res.status(400).json({ok:false, msg:'تحقق من الحقول الإلزامية', fields: missing});
  }

  const allowed = new Set(['CLOSED_RESOLVED','CLOSED_TRANSFERRED','CLOSED_AWAITING','CLOSED_NOT_RESOLVED','CLOSED_APPOINTMENT_BOOKED']);
  const st = allowed.has(outcome_status) ? outcome_status : 'CLOSED_RESOLVED';

  t.status = st;
  t.closed_at = new Date().toISOString();
  t.closed_by_user_id = req.session.counter_user.id;

  let c = db.cases.find(x=>String(x.ticket_id)===ticketIdStr);
  if (!c){
    const id = db.cases.length ? Math.max(...db.cases.map(x=>x.id))+1 : 1;
    c = {
      id, ticket_id,
      summary:'', details:'', phone:'',
      outcome_code:'', not_resolved_reason:'',
      category:'', priority:'normal', channel:'walkin',
      internal_notes:'', transfer_to:'', awaiting_from:'', due_date:'',
      appointment_id: null,
      created_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    };
    // normalize stored ticket_id type
    c.ticket_id = ticketIdStr;
    db.cases.push(c);
  }

  // Defaults for older records
  c.category = c.category ?? '';
  c.priority = c.priority ?? 'normal';
  c.channel = c.channel ?? 'walkin';
  c.internal_notes = c.internal_notes ?? '';
  c.transfer_to = c.transfer_to ?? '';
  c.awaiting_from = c.awaiting_from ?? '';
  c.due_date = c.due_date ?? '';
  c.appointment_id = c.appointment_id ?? null;

  // Save close data
  c.summary = String(summary).trim();
  c.details = details ? String(details) : '';
  // prefer explicit phone; otherwise use ticket phone
  c.phone = phone ? String(phone) : (t.phone || (t.beneficiary && t.beneficiary.phone) || '');
  c.outcome_code = st;
  c.not_resolved_reason = not_resolved_reason ? String(not_resolved_reason) : '';

  // Optional case fields from UI (if provided)
  if (category != null) c.category = String(category);
  if (priority != null) c.priority = String(priority);
  if (channel != null) c.channel = String(channel);
  if (internal_notes != null) c.internal_notes = String(internal_notes);
  if (transfer_to != null) c.transfer_to = String(transfer_to);
  if (awaiting_from != null) c.awaiting_from = String(awaiting_from);
  if (due_date != null) c.due_date = String(due_date);

  c.updated_at = new Date().toISOString();


  // If appointment slot selected, book it and mark outcome accordingly
  if (appointment_slot_id){
  const slotId = Number(appointment_slot_id);
  const slot = (db.appointments||[]).find(a=>a.id===slotId && a.status==='available');
  if (slot){
    slot.status = 'booked';
    slot.booked_ticket_id = t.id;
    slot.booked_by_user_id = req.session.counter_user.id;
    slot.booked_name = t.beneficiary_type || '';
    slot.booked_phone = c.phone || '';
    slot.booked_national_id = t.national_id || (t.beneficiary && t.beneficiary.national_id) || '';
    slot.booked_at = new Date().toISOString();
    c.appointment_id = slot.id;
    // set ticket final status if not already
    t.status = 'CLOSED_APPOINTMENT_BOOKED';
    t.closed_at = new Date().toISOString();
    t.closed_by_user_id = req.session.counter_user.id;
    c.outcome_code = 'CLOSED_APPOINTMENT_BOOKED';
  }
  }

  // These helpers should never break the close flow.
  try{ createFeedbackWindow(t, s.counter_id, req.session.counter_user.id); }catch(e){}

  try{ scheduleAutoCall(s.counter_id); }catch(e){}
  saveDb();

  // Set a one-time flash flag so the counter screen can show "تم الإغلاق" even if the operator
  // navigates away immediately (e.g., opens evaluation) and comes back later.
  try{ req.session.counter_closed_flash = 1; }catch(e){}

  res.json({ok:true, closed_flash:true});
});

app.post('/counter/settings', requireCounterLogin, (req,res)=>{
  // Settings were moved to Admin panel to keep counters lean and consistent.
  return res.status(403).json({ok:false, msg:'تم نقل الإعدادات إلى لوحة المدير.'});
});



// Ticket details + attachments + appointments APIs
app.get('/api/ticket/:id', requireCounterLogin, (req,res)=>{
  loadDb();
  const ticketId = String(req.params.id);
  const t = db.tickets.find(x=>String(x.id)===ticketId);
  if (!t) return res.status(404).json({ok:false, msg:'not found'});

  // only allow if ticket belongs to this counter session
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  if (!s || !s.counter_id || String(t.assigned_counter_id) !== String(s.counter_id)){
    return res.status(403).json({ok:false, msg:'forbidden'});
  }

  const c = ensureCase(ticketId);
  const atts = listAttachments(ticketId);

  const service = getService(t.service_id);
  let slotsPayload = null;
  if (service && service.type === 'appointment' && (db.settings.appointments && db.settings.appointments.enabled)){
    const next = getAvailableSlotsForNextDay();
    slotsPayload = next;
  }

  res.json({ok:true, ticket: t, case: c, attachments: atts, appointment: slotsPayload});
});

// Get appointment slots for a specific date (counter UI calendar)
app.get('/api/appointments/slots', requireCounterLogin, (req,res)=>{
  loadDb();
  if (!(db.settings && db.settings.appointments && db.settings.appointments.enabled)){
    return res.json({ok:true, appointment: null});
  }

  const wd = Number(db.settings.appointments.weekday);
  let requested = String(req.query.date || '').slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)){
    // default to next available day
    const next = getAvailableSlotsForNextDay();
    return res.json({ok:true, appointment: {...next, requested_date: '', adjusted:false}});
  }

  let useDate = requested;
  const dow = dayOfWeek(requested);
  let adjusted = false;
  if (Number.isFinite(wd) && dow !== wd){
    // If selected date isn't the configured weekday, jump to the next configured weekday.
    useDate = nextAppointmentDate(requested, wd);
    adjusted = true;
  }
  ensureSlotsForDate(useDate);
  const slots = (db.appointments||[])
    .filter(a=>a.date===useDate && a.status==='available')
    .sort((a,b)=> timeToMinutes(a.start_time)-timeToMinutes(b.start_time));

  return res.json({ok:true, appointment: {date: useDate, slots, requested_date: requested, adjusted}});
});

app.post('/counter/case/save', requireCounterLogin, (req,res)=>{
  loadDb();
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  const {ticket_id, category, priority, channel, internal_notes, transfer_to, awaiting_from, due_date, phone} = req.body;
  const t = db.tickets.find(x=>String(x.id)===String(ticket_id));
  if (!s || !s.counter_id || !t || String(t.assigned_counter_id) !== String(s.counter_id)){
    return res.status(403).json({ok:false});
  }
  const c = ensureCase(String(ticket_id));
  if (category != null) c.category = String(category);
  if (priority != null) c.priority = String(priority);
  if (channel != null) c.channel = String(channel);
  if (internal_notes != null) c.internal_notes = String(internal_notes);
  if (transfer_to != null) c.transfer_to = String(transfer_to);
  if (awaiting_from != null) c.awaiting_from = String(awaiting_from);
  if (due_date != null) c.due_date = String(due_date);
  if (phone != null) c.phone = String(phone);
  c.updated_at = new Date().toISOString();
  saveDb();
  res.json({ok:true});
});

app.post('/counter/attachment/upload', requireCounterLogin, upload.single('file'), (req,res)=>{
  loadDb();
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  const {ticket_id} = req.body;
  const t = db.tickets.find(x=>String(x.id)===String(ticket_id));
  if (!s || !s.counter_id || !t || String(t.assigned_counter_id) !== String(s.counter_id)){
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(403).json({ok:false});
  }
  if (!req.file) return res.status(400).json({ok:false, msg:'no file'});

  const id = db.attachments.length ? Math.max(...db.attachments.map(a=>a.id))+1 : 1;
  db.attachments.push({
    id,
    ticket_id: String(ticket_id),
    stored_name: path.basename(req.file.path),
    original_name: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    uploaded_by_user_id: req.session.counter_user.id,
    uploaded_at: new Date().toISOString()
  });
  saveDb();
  res.json({ok:true, attachment_id: id});
});

app.get('/files/:id', requireAnyAuth, (req,res)=>{
  loadDb();
  const id = Number(req.params.id);
  const a = (db.attachments||[]).find(x=>x.id===id);
  if (!a) return res.status(404).send('Not found');
  const fp = path.join(__dirname, 'data', 'uploads', a.stored_name);
  if (!fs.existsSync(fp)) return res.status(404).send('Missing file');
  res.download(fp, a.original_name);
});

app.post('/counter/appointments/book', requireCounterLogin, (req,res)=>{
  loadDb();
  const sid = req.session.counter_session_id;
  const s = findSessionById(sid);
  const {ticket_id, slot_id, phone} = req.body;
  const t = db.tickets.find(x=>String(x.id)===String(ticket_id));
  if (!s || !s.counter_id || !t || String(t.assigned_counter_id) !== String(s.counter_id)){
    return res.status(403).json({ok:false});
  }
  const slot = (db.appointments||[]).find(a=>a.id===Number(slot_id));
  if (!slot || slot.status!=='available') return res.status(400).json({ok:false, msg:'slot not available'});

  const c = ensureCase(String(ticket_id));
  if (phone) c.phone = String(phone);

  slot.status = 'booked';
  slot.booked_ticket_id = t.id;
  slot.booked_by_user_id = req.session.counter_user.id;
  slot.booked_phone = c.phone || '';
  slot.booked_national_id = (t.beneficiary && t.beneficiary.national_id) || t.national_id || '';
  slot.booked_at = new Date().toISOString();
  c.appointment_id = slot.id;
  c.updated_at = new Date().toISOString();

  saveDb();
  res.json({ok:true, slot});
});

// Allow counter staff to adjust the appointment day (per the office's coordination)
app.post('/counter/appointments/weekday', requireCounterLogin, (req,res)=>{
  // Settings were moved to Admin panel.
  return res.status(403).json({ok:false, msg:'تم نقل إعدادات المواعيد إلى لوحة المدير.'});
});

// Feedback
app.get('/feedback', (req,res)=>{
  loadDb();
  const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
  const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
  const counterId = req.query.counter_id;
  const w = getCurrentFeedbackWindowFor(counterId);
  const ticket = w ? db.tickets.find(t=>t.id===w.ticket_id) : null;
  const counter = w ? db.counters.find(c=>c.id===w.counter_id) : null;
  const employee = w ? db.users.find(u=>u.id===w.user_id) : null;
  const lang = (req.query.lang || (ticket && ticket.lang) || (req.session && req.session.kiosk_lang) || 'ar');
  res.render('feedback', {
    lang,
    ui,
    branding,
    window: w,
    ticket,
    counter,
    employee,
    q1: db.settings.question1_text,
    q2: db.settings.question2_text
  });
});

app.get('/api/feedback/current', (req,res)=>{
  loadDb();
  const w = getCurrentFeedbackWindowFor(req.query.counter_id);
  if (!w) return res.json({ok:true, window:null});
  res.json({ok:true, window:w, q1: db.settings.question1_text, q2: db.settings.question2_text});
});

app.post('/feedback/submit', (req,res)=>{
  loadDb();
  const {ticket_id, solved_yes_no, employee_rating, reason_code} = req.body;
  const w = getCurrentFeedbackWindowFor(req.body.counter_id || req.query.counter_id);
  if (!w || w.ticket_id !== ticket_id){
    // If form submit, show friendly page instead of raw JSON.
    if ((req.headers.accept || '').includes('text/html')){
      const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
      const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
      return res.status(400).render('feedback_done', { ui, branding, ok:false });
    }
    return res.status(400).json({ok:false});
  }
  const rating = Number(employee_rating);
  if (!Number.isFinite(rating) || rating<1 || rating>5){
    if ((req.headers.accept || '').includes('text/html')){
      const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
      const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
      return res.status(400).render('feedback_done', { ui, branding, ok:false });
    }
    return res.status(400).json({ok:false});
  }

  w.consumed = true;

  if (!db.feedback.find(f=>f.ticket_id===ticket_id)){
    const id = db.feedback.length? Math.max(...db.feedback.map(x=>x.id))+1:1;
    db.feedback.push({
      id,
      ticket_id,
      counter_id: w.counter_id,
      user_id: w.user_id,
      solved_yes_no: (String(solved_yes_no)==='true' || solved_yes_no===true),
      employee_rating: rating,
      reason_code: reason_code ? String(reason_code) : null,
      created_at: new Date().toISOString()
    });
  }
  saveDb();
  if ((req.headers.accept || '').includes('text/html')){
    const ui = (db.settings && db.settings.ui) ? db.settings.ui : {theme:'dark'};
    const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
    return res.render('feedback_done', { ui, branding, ok:true });
  }
  res.json({ok:true});
});

// Admin
app.get('/admin/login', (req,res)=>{ loadDb(); res.render('admin_login', {error:null}); });

app.post('/admin/login', (req,res)=>{
  loadDb();
  const {username, password} = req.body;
  const user = db.users.find(u=>u.username===username && u.password===password && u.is_active && (u.role==='admin' || u.role==='supervisor'));
  if (!user) return res.render('admin_login', {error:'بيانات الدخول غير صحيحة'});
  req.session.admin_user = {id:user.id, username:user.username, full_name:user.full_name, role:user.role};
  // Supervisor gets a limited entry point
  if (user.role === 'supervisor') return res.redirect('/admin/reports');
  res.redirect('/admin');
});

app.get('/admin/logout', (req,res)=>{
  // Logout admin without killing Counter session (if open in another tab)
  req.session.admin_user = null;
  res.redirect('/admin/login');
});

app.get('/admin', requireAdmin, (req,res)=>{
  loadDb();
  const workDate = getWorkDate();

  // ensure daily rows exist
  const hasToday = db.counter_daily.some(x=>x.work_date===workDate);
  if (!db.counter_daily) db.counter_daily = [];
  // Do NOT wipe history. If today has no rows yet, we will create defaults below.
  const existing = new Set(db.counter_daily.filter(x=>x.work_date===workDate).map(x=>x.counter_id));
  db.counters.forEach(c=>{
    if (!existing.has(c.id)){
      db.counter_daily.push({work_date: workDate, counter_id: c.id, enabled_today: true});
    }
  });

  const daily = getCounterDailyMap(workDate);
  const activeSessions = getActiveSessions();
  const counterRows = db.counters
    .slice()
    .sort((a,b)=>a.priority_order-b.priority_order)
    .map(c=>{
      const ses = activeSessions.find(s=>s.counter_id===c.id) || null;
      const user = ses ? db.users.find(u=>u.id===ses.user_id) : null;
      return {...c, enabled_today: daily.get(c.id)===true, session_user: user ? user.full_name : null};
    });

  saveDb();
  res.render('admin', { user:req.session.admin_user, workDate, counters: counterRows, services: db.services.slice().sort((a,b)=>a.id-b.id), settings: db.settings, users: db.users.slice().sort((a,b)=>a.id-b.id) });
});

// Admin - branding (logo & headers)
app.get('/admin/branding', requireAdmin, (req,res)=>{
  loadDb();
  const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
  const report_meta = (db.settings && db.settings.report_meta) ? db.settings.report_meta : {};
  const feedback_mode = (db.settings && db.settings.feedback_mode) ? db.settings.feedback_mode : 'shared';
  const flash = req.session.flash || null;
  req.session.flash = null;
  res.render('admin_branding', { user:req.session.admin_user, branding, report_meta, feedback_mode, flash });
});

app.post('/admin/branding/update', requireAdmin, (req,res)=>{
  loadDb();
  if (!db.settings) db.settings = {};
  if (!db.settings.branding) db.settings.branding = {};
  if (!db.settings.report_meta) db.settings.report_meta = {};
  const b = db.settings.branding;
  const m = db.settings.report_meta;
  b.org_name_ar = (req.body.org_name_ar || b.org_name_ar || '').toString().trim();
  b.org_name_en = (req.body.org_name_en || b.org_name_en || '').toString().trim();
  b.org_unit_ar = (req.body.org_unit_ar || b.org_unit_ar || '').toString().trim();
  b.org_unit_en = (req.body.org_unit_en || b.org_unit_en || '').toString().trim();
  b.location_ar = (req.body.location_ar || b.location_ar || '').toString().trim();
  b.location_en = (req.body.location_en || b.location_en || '').toString().trim();

  // Report approval meta (printed at the bottom of PDF reports)
  m.supervisor = (req.body.supervisor || m.supervisor || '').toString().trim();
  m.prepared_by = (req.body.prepared_by || m.prepared_by || '').toString().trim();
  m.reviewed_by = (req.body.reviewed_by || m.reviewed_by || '').toString().trim();
  m.approved_by = (req.body.approved_by || m.approved_by || '').toString().trim();
  m.report_version = (req.body.report_version || m.report_version || '').toString().trim();
  saveDb();
  req.session.flash = { type:'success', msg:'تم حفظ بيانات الهوية.' };
  res.redirect('/admin/branding');
});

app.post('/admin/branding/logo', requireAdmin, brandingUpload.single('logo_file'), (req,res)=>{
  loadDb();
  try{
    if (!req.file) throw new Error('no file');
    const ext = path.extname(req.file.filename).toLowerCase();
    const publicPath = '/public/branding/' + req.file.filename;
    if (!db.settings) db.settings = {};
    if (!db.settings.branding) db.settings.branding = {};
    db.settings.branding.logo_path = publicPath;
    saveDb();
    req.session.flash = { type:'success', msg:'تم رفع الشعار بنجاح.' };
  }catch(e){
    req.session.flash = { type:'danger', msg:'تعذر رفع الشعار.' };
  }
  res.redirect('/admin/branding');
});

// Admin - reports
function computeReportsPayload(query){
  loadDb();

  // Date filter: quick ranges + custom (from/to)
  const range = String(query.range || 'today').toLowerCase();
  let from = clampDateStr(query.from);
  let to = clampDateStr(query.to);

  const today = todayStr();
  if (range === 'today'){
    from = today; to = today;
  } else if (range === 'week'){
    from = dateAddDaysStr(today, -6);
    to = today;
  } else if (range === 'month'){
    from = dateAddDaysStr(today, -29);
    to = today;
  } else {
    // custom
    from = from || today;
    to = to || from;
  }

  const tickets = (db.tickets || []).filter(t => {
    const d = toDateOnly(t.created_at);
    return inDateRange(d, from, to);
  });

  const feedback = (db.feedback || []).filter(f => {
    const d = toDateOnly(f.created_at || f.submitted_at);
    return inDateRange(d, from, to);
  });

  // --- Aggregates ---
  const statusSummary = new Map();
  tickets.forEach(t=>{
    const st = String(t.status||'NEW');
    statusSummary.set(st, (statusSummary.get(st)||0)+1);
  });

  // Services
  const serviceSummary = new Map();
  tickets.forEach(t=>{
    const sid = String(t.service_id || '');
    const sName = (t.service_name_ar || (getService(t.service_id)?.name_ar) || '—');
    if (!serviceSummary.has(sid)) serviceSummary.set(sid, {service_id:t.service_id, service_name:sName, total:0, closed:0, waitSum:0, waitN:0, serveSum:0, serveN:0});
    const row = serviceSummary.get(sid);
    row.total++;
    if (t.status==='CLOSED') row.closed++;
    if (t.called_at && t.created_at){
      const w = (new Date(t.called_at) - new Date(t.created_at)) / 1000;
      if (w>=0 && w<24*3600){ row.waitSum += w; row.waitN++; }
    }
    if (t.closed_at && t.in_service_at){
      const s = (new Date(t.closed_at) - new Date(t.in_service_at)) / 1000;
      if (s>=0 && s<24*3600){ row.serveSum += s; row.serveN++; }
    }
  });

  // Counters
  const counterSummary = new Map();
  tickets.forEach(t=>{
    const cid = t.assigned_counter_id;
    const c = db.counters.find(x=>x.id===cid);
    const name = c ? c.name : 'غير محدد';
    if (!counterSummary.has(String(cid||'null'))) counterSummary.set(String(cid||'null'), {counter_id:cid, counter_name:name, total:0, closed:0});
    const row = counterSummary.get(String(cid||'null'));
    row.total++; if (t.status==='CLOSED') row.closed++;
  });

  // Employees
  const employeeSummary = new Map();
  tickets.forEach(t=>{
    if (!t.assigned_user_id) return;
    const uid = String(t.assigned_user_id);
    const u = db.users.find(x=>x.id===t.assigned_user_id);
    if (!employeeSummary.has(uid)) employeeSummary.set(uid, {user_id:t.assigned_user_id, employee_name:u?u.full_name:('ID '+uid), total:0, closed:0, no_show:0, avg_rating:null, ratingSum:0, ratingN:0});
    const row = employeeSummary.get(uid);
    row.total++;
    if (t.status==='CLOSED') row.closed++;
    if (t.status==='NO_SHOW') row.no_show++;
  });
  feedback.forEach(f=>{
    const uid = String(f.user_id || '');
    if (!uid) return;
    if (!employeeSummary.has(uid)){
      const u = db.users.find(x=>x.id===f.user_id);
      employeeSummary.set(uid, {user_id:f.user_id, employee_name:u?u.full_name:('ID '+uid), total:0, closed:0, no_show:0, avg_rating:null, ratingSum:0, ratingN:0});
    }
    const row = employeeSummary.get(uid);
    const r = Number(f.employee_rating);
    if (Number.isFinite(r)){ row.ratingSum += r; row.ratingN++; }
  });
  employeeSummary.forEach(row=>{
    row.avg_rating = row.ratingN ? (row.ratingSum/row.ratingN) : null;
  });

  // Feedback detail rows
  const feedbackRows = feedback.slice().sort((a,b)=> new Date(b.created_at||0)-new Date(a.created_at||0)).map(f=>{
    const t = db.tickets.find(x=>x.id===f.ticket_id);
    const c = db.counters.find(x=>x.id===f.counter_id);
    const u = db.users.find(x=>x.id===f.user_id);
    return {
      id: f.id,
      ticket_code: t ? t.ticket_code : (f.ticket_id||'—'),
      counter_name: c ? c.name : '—',
      employee_name: u ? u.full_name : '—',
      solved_yes_no: f.solved_yes_no,
      employee_rating: f.employee_rating,
      created_at: f.created_at || f.submitted_at
    };
  });

  // Overall stats
  let waitSum = 0, waitN = 0;
  let serveSum = 0, serveN = 0;
  let closed = 0;
  tickets.forEach(t => {
    if (t.called_at && t.created_at){
      const w = (new Date(t.called_at) - new Date(t.created_at)) / 1000;
      if (w >= 0 && w < 24*3600){ waitSum += w; waitN++; }
    }
    if (t.closed_at && t.in_service_at){
      const s = (new Date(t.closed_at) - new Date(t.in_service_at)) / 1000;
      if (s >= 0 && s < 24*3600){ serveSum += s; serveN++; }
    }
    if (t.status === 'CLOSED') closed++;
  });

  let q1Yes = 0, q1No = 0;
  let q2Sum = 0, q2N = 0;
  feedback.forEach(f => {
    if (f.solved_yes_no === true) q1Yes++;
    if (f.solved_yes_no === false) q1No++;
    const r = Number(f.employee_rating);
    if (Number.isFinite(r)) { q2Sum += r; q2N++; }
  });

  const stats = {
    range, from, to,
    tickets_total: tickets.length,
    tickets_closed: closed,
    avg_wait_sec: waitN ? (waitSum / waitN) : null,
    avg_service_sec: serveN ? (serveSum / serveN) : null,
    feedback_total: feedback.length,
    q1_yes: q1Yes,
    q1_no: q1No,
    q2_avg: q2N ? (q2Sum / q2N) : null
  };

  const statusRows = Array.from(statusSummary.entries()).map(([k,v])=>({status:k, count:v})).sort((a,b)=>b.count-a.count);
  const serviceRows = Array.from(serviceSummary.values()).map(r=>({
    ...r,
    avg_wait_sec: r.waitN ? (r.waitSum/r.waitN) : null,
    avg_service_sec: r.serveN ? (r.serveSum/r.serveN) : null
  })).sort((a,b)=>b.total-a.total);
  const counterRows = Array.from(counterSummary.values()).sort((a,b)=>b.total-a.total);
  const employeeRows = Array.from(employeeSummary.values()).sort((a,b)=> (b.closed - a.closed) || (b.total-a.total));

  return {
    stats,
    range, from, to,
    statusRows,
    serviceRows,
    counterRows,
    employeeRows,
    feedbackRows,
    tickets
  };
}

app.get('/admin/reports', requireReportsAccess, (req,res)=>{
  const payload = computeReportsPayload(req.query);
  res.render('admin_reports', { user:req.session.admin_user, ...payload });
});

// Live JSON for auto-refresh (charts + KPIs)
app.get('/admin/reports/live.json', requireReportsAccess, (req,res)=>{
  try{
    const payload = computeReportsPayload(req.query);
    // Keep response small for frequent polling
    res.json({
      ok:true,
      at: new Date().toISOString(),
      stats: payload.stats,
      statusRows: payload.statusRows,
      serviceRows: payload.serviceRows,
      counterRows: payload.counterRows,
      employeeRows: payload.employeeRows
    });
  }catch(e){
    res.status(500).json({ok:false, error:String(e && e.message ? e.message : e)});
  }
});

// Exports
app.get('/admin/reports/export.csv', requireReportsAccess, (req,res)=>{
  loadDb();
  const type = String(req.query.type||'tickets');
  const range = String(req.query.range || 'today').toLowerCase();
  let from = clampDateStr(req.query.from);
  let to = clampDateStr(req.query.to);
  const today = todayStr();
  if (range === 'today'){ from = today; to = today; }
  else if (range === 'week'){ from = dateAddDaysStr(today, -6); to = today; }
  else if (range === 'month'){ from = dateAddDaysStr(today, -29); to = today; }
  else { from = from || today; to = to || from; }

  const inRangeTickets = db.tickets.filter(t => inDateRange(toDateOnly(t.created_at), from, to));
  const inRangeFeedback = (db.feedback || []).filter(f => inDateRange(toDateOnly(f.created_at || f.submitted_at), from, to));

  let filename = `report_${type}_${from}_to_${to}.csv`;
  let csv = '';

  if (type === 'feedback'){
    const headers = ['ticket_code','counter','employee','solved_yes_no','employee_rating','reason','submitted_at'];
    const rows = inRangeFeedback.map(f=>{
      const t = db.tickets.find(x=>x.id===f.ticket_id);
      const c = db.counters.find(x=>x.id===f.counter_id);
      const u = db.users.find(x=>x.id===f.user_id);
      return [
        t ? t.ticket_code : (f.ticket_id||''),
        c ? c.name : '',
        u ? (u.full_name || u.username) : '',
        (f.solved_yes_no===true)?'yes':(f.solved_yes_no===false?'no':''),
        f.employee_rating,
        f.reason_code || '',
        f.created_at || ''
      ];
    });
    csv = buildCsv(headers, rows);
  } else if (type === 'employees'){
    // employee performance
    const byUser = new Map();
    inRangeTickets.forEach(t=>{
      if (!t.served_by_user_id) return;
      const row = byUser.get(t.served_by_user_id) || {served:0, closed:0, waitSum:0, waitN:0, serviceSum:0, serviceN:0, ratingsSum:0, ratingsN:0};
      row.served++;
      if (t.status==='CLOSED') row.closed++;
      if (t.called_at && t.created_at){
        const w = (new Date(t.called_at) - new Date(t.created_at))/1000;
        if (w>=0 && w<24*3600){ row.waitSum += w; row.waitN++; }
      }
      if (t.closed_at && t.in_service_at){
        const s = (new Date(t.closed_at) - new Date(t.in_service_at))/1000;
        if (s>=0 && s<24*3600){ row.serviceSum += s; row.serviceN++; }
      }
      byUser.set(t.served_by_user_id, row);
    });
    inRangeFeedback.forEach(f=>{
      if (!f.user_id) return;
      const row = byUser.get(f.user_id) || {served:0, closed:0, waitSum:0, waitN:0, serviceSum:0, serviceN:0, ratingsSum:0, ratingsN:0};
      const r = Number(f.employee_rating);
      if (Number.isFinite(r)) { row.ratingsSum += r; row.ratingsN++; }
      byUser.set(f.user_id, row);
    });

    const headers = ['employee','username','served_tickets','closed_tickets','avg_wait_min','avg_service_min','avg_rating'];
    const rows = Array.from(byUser.entries()).map(([uid, row])=>{
      const u = db.users.find(x=>x.id===uid);
      return [
        u ? (u.full_name || u.username) : String(uid),
        u ? u.username : '',
        row.served,
        row.closed,
        row.waitN ? Math.round((row.waitSum/row.waitN)/60) : '',
        row.serviceN ? Math.round((row.serviceSum/row.serviceN)/60) : '',
        row.ratingsN ? (row.ratingsSum/row.ratingsN).toFixed(2) : ''
      ];
    }).sort((a,b)=> (Number(b[2])||0) - (Number(a[2])||0));

    csv = buildCsv(headers, rows);

  } else if (type === 'status'){
    const byStatus = new Map();
    inRangeTickets.forEach(t=>{
      const st = String(t.status||'NEW');
      byStatus.set(st, (byStatus.get(st)||0)+1);
    });
    const headers = ['status','count'];
    const rows = Array.from(byStatus.entries()).sort((a,b)=>b[1]-a[1]).map(([st,cnt])=>[st,cnt]);
    csv = buildCsv(headers, rows);
  } else if (type === 'services'){
    const byService = new Map();
    inRangeTickets.forEach(t=>{
      const sid = String(t.service_id||'');
      const name = (t.service_name_ar || (getService(t.service_id)?.name_ar) || '—');
      const row = byService.get(sid) || {service_id:t.service_id, service_name:name, total:0, closed:0};
      row.total++; if (t.status==='CLOSED') row.closed++;
      byService.set(sid, row);
    });
    const headers = ['service_id','service_name','total','closed'];
    const rows = Array.from(byService.values()).sort((a,b)=>b.total-a.total).map(r=>[r.service_id, r.service_name, r.total, r.closed]);
    csv = buildCsv(headers, rows);
  } else if (type === 'counters'){
    const byCounter = new Map();
    inRangeTickets.forEach(t=>{
      const cid = t.assigned_counter_id;
      const c = db.counters.find(x=>x.id===cid);
      const name = c ? c.name : 'غير محدد';
      const row = byCounter.get(String(cid||'null')) || {counter_id:cid, counter_name:name, total:0, closed:0};
      row.total++; if (t.status==='CLOSED') row.closed++;
      byCounter.set(String(cid||'null'), row);
    });
    const headers = ['counter_id','counter_name','total','closed'];
    const rows = Array.from(byCounter.values()).sort((a,b)=>b.total-a.total).map(r=>[r.counter_id||'', r.counter_name, r.total, r.closed]);
    csv = buildCsv(headers, rows);
  } else {
    // tickets (default)
    const headers = ['ticket_code','service','beneficiary_type','beneficiary_name','national_id','phone','counter','status','created_at','called_at','in_service_at','closed_at','served_by','outcome','summary'];
    const rows = inRangeTickets
      .slice()
      .sort((a,b)=> new Date(a.created_at)-new Date(b.created_at))
      .map(t=>{
        const s = getService(t.service_id);
        const c = db.counters.find(x=>x.id===t.assigned_counter_id);
        const u = db.users.find(x=>x.id===t.served_by_user_id);
        const beneficiary = t.beneficiary || {};
        const ca = db.cases.find(x=>x.ticket_id===t.id) || {};
        return [
          t.ticket_code,
          (t.service_name_ar || (s && s.name_ar) || t.service_name || ''),
          beneficiary.beneficiary_type || '',
          beneficiary.full_name || '',
          beneficiary.national_id || '',
          beneficiary.phone || ca.phone || '',
          c ? c.name : '',
          t.status,
          t.created_at || '',
          t.called_at || '',
          t.in_service_at || '',
          t.closed_at || '',
          u ? (u.full_name || u.username) : '',
          t.outcome_status || '',
          (t.summary || ca.summary || '')
        ];
      });
    csv = buildCsv(headers, rows);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // UTF-8 BOM for Excel
  res.send('\uFEFF' + csv);
});

app.get('/admin/reports/export.pdf', requireReportsAccess, (req,res)=>{
  loadDb();
  const type = String(req.query.type||'tickets');
  const range = String(req.query.range || 'today').toLowerCase();
  let from = clampDateStr(req.query.from);
  let to = clampDateStr(req.query.to);
  const today = todayStr();
  if (range === 'today'){ from = today; to = today; }
  else if (range === 'week'){ from = dateAddDaysStr(today, -6); to = today; }
  else if (range === 'month'){ from = dateAddDaysStr(today, -29); to = today; }
  else { from = from || today; to = to || from; }
  const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
  const ui = (db.settings && db.settings.ui) ? db.settings.ui : {};

  // Gather datasets
  const tickets = db.tickets.filter(t => inDateRange(toDateOnly(t.created_at), from, to));
  const feedback = (db.feedback || []).filter(f => inDateRange(toDateOnly(f.created_at || f.submitted_at), from, to));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="report_${type}_${from}_to_${to}.pdf"`);

  const doc = new PDFDocument({size:'A4', margin:42});
  doc.pipe(res);

  // font
  try{
    const fontPath = path.join(__dirname, 'public', 'fonts', 'DejaVuSans.ttf');
    if (fs.existsSync(fontPath)) doc.font(fontPath);
  }catch(e){ /* ignore */ }

  const titleAr = (branding.org_unit_ar || branding.org_name_ar || 'تقرير');
  const titleEn = (branding.org_unit_en || branding.org_name_en || 'Report');

  // Header (bilingual) – use Arabic shaping helper for PDFKit
  doc.fontSize(18).fillColor('#111').text(titleEn, {align:'center'});
  doc.fontSize(18).text(arPdf(titleAr), {align:'center'});
  doc.moveDown(0.3);
  doc.fontSize(11).fillColor('#555').text(`Range: ${from} → ${to}`, {align:'center'});
  doc.moveDown(1);

  // Summary
  const totalTickets = tickets.length;
  const totalFeedback = feedback.length;
  const closed = tickets.filter(t=>t.status==='CLOSED').length;
  doc.fillColor('#111').fontSize(13).text('Summary / ' + arPdf('ملخص'), {align:'left'});
  doc.fontSize(10).fillColor('#333');
  doc.text(`Tickets: ${totalTickets} | Closed: ${closed} | Feedback: ${totalFeedback}`);
  doc.moveDown(0.8);

  // ---------- PDF UI helpers (cards + charts) ----------
  const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  function fmtMins(seconds){
    if (!Number.isFinite(seconds) || seconds < 0) return '-';
    return `${Math.round(seconds/60)}m`;
  }

  function sectionTitle(arText, enText){
    doc.moveDown(0.6);
    doc.fontSize(13).fillColor('#111').text(`${enText || ''}`, {align:'left'});
    if (arText) doc.fontSize(12).fillColor('#111').text(arPdf(arText), {align:'right'});
    doc.moveDown(0.2);
  }

  function drawKpiCards(items){
    const gap = 10;
    const cols = Math.min(4, Math.max(2, items.length));
    const cardW = (contentW - gap*(cols-1)) / cols;
    const cardH = 56;
    const x0 = doc.x;
    let y0 = doc.y;
    items.slice(0, cols).forEach((it, i)=>{
      const x = x0 + i*(cardW + gap);
      doc.save();
      doc.roundedRect(x, y0, cardW, cardH, 10).fill('#ffffff');
      doc.strokeColor('#e6e6e6').lineWidth(1).roundedRect(x, y0, cardW, cardH, 10).stroke();
      doc.fillColor('#555').fontSize(9).text(String(it.label||''), x+10, y0+10, {width: cardW-20, align:'left'});
      doc.fillColor('#111').fontSize(16).text(String(it.value||''), x+10, y0+26, {width: cardW-20, align:'left'});
      doc.restore();
    });
    doc.y = y0 + cardH + 12;
  }

  function drawBarChart(title, labels, values, opts={}){
    const maxBars = opts.maxBars || 10;
    const data = labels.map((l,i)=>({label:l, value:Number(values[i])||0})).sort((a,b)=>b.value-a.value).slice(0, maxBars);
    const x = doc.x;
    const y = doc.y;
    const w = contentW;
    const h = 190;
    const pad = 12;
    const top = 28;
    const bottom = 26;
    const chartH = h - top - bottom;
    const n = Math.max(1, data.length);
    const barW = (w - pad*2) / n;
    const maxV = Math.max(1, ...data.map(d=>d.value));

    doc.save();
    doc.roundedRect(x, y, w, h, 12).fill('#ffffff');
    doc.strokeColor('#e6e6e6').lineWidth(1).roundedRect(x, y, w, h, 12).stroke();
    doc.fillColor('#111').fontSize(11).text(title, x+12, y+10);

    // baseline
    doc.strokeColor('#e9e9e9').lineWidth(1).moveTo(x+pad, y+top+chartH).lineTo(x+w-pad, y+top+chartH).stroke();

    data.forEach((d,i)=>{
      const bh = Math.max(2, (d.value/maxV)*chartH);
      const bx = x + pad + i*barW + (barW*0.15);
      const bw = barW*0.70;
      const by = y + top + (chartH - bh);
      doc.fillColor('#15445a').roundedRect(bx, by, bw, bh, 6).fill();
      doc.fillColor('#0b1f29').fontSize(7).text(String(d.value), bx, by-10, {width:bw, align:'center'});
      const lbl = String(d.label||'').slice(0, 12);
      doc.fillColor('#555').fontSize(7).text(lbl, bx-6, y+top+chartH+6, {width:bw+12, align:'center'});
    });

    doc.restore();
    doc.y = y + h + 12;
  }

  function drawPieChart(title, labels, values){
    const data = labels.map((l,i)=>({label:l, value:Number(values[i])||0})).filter(d=>d.value>0);
    const total = data.reduce((s,d)=>s+d.value,0) || 1;
    const x = doc.x;
    const y = doc.y;
    const w = contentW;
    const h = 200;
    doc.save();
    doc.roundedRect(x, y, w, h, 12).fill('#ffffff');
    doc.strokeColor('#e6e6e6').lineWidth(1).roundedRect(x, y, w, h, 12).stroke();
    doc.fillColor('#111').fontSize(11).text(title, x+12, y+10);

    const cx = x + 110;
    const cy = y + 115;
    const r = 60;
    const colors = ['#15445a','#3d7eb9','#07a869','#c1b489','#0da9a6','#6b7280'];
    let ang = -Math.PI/2;
    data.forEach((d, idx)=>{
      const a = (d.value/total) * Math.PI*2;
      doc.moveTo(cx, cy);
      doc.fillColor(colors[idx % colors.length]);
      doc.arc(cx, cy, r, (ang*180/Math.PI), ((ang+a)*180/Math.PI)).lineTo(cx,cy).fill();
      ang += a;
    });

    // Legend
    let ly = y + 40;
    const lx = x + 200;
    data.forEach((d, idx)=>{
      const col = colors[idx % colors.length];
      doc.fillColor(col).rect(lx, ly+3, 10, 10).fill();
      doc.fillColor('#333').fontSize(9).text(`${String(d.label)} (${d.value})`, lx+14, ly, {width: w-(lx-x)-20});
      ly += 18;
    });

    doc.restore();
    doc.y = y + h + 12;
  }


  // Table helper
  function table(headers, rows){
    const startX = doc.page.margins.left;
    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colW = pageW / headers.length;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    const padX = 3;
    const padY = 2;

    function drawHeader(){
      // ensure space for header
      if (doc.y + 18 > bottomLimit) doc.addPage();
      const y = doc.y;
      doc.save();
      // header background
      doc.fillColor('#f5f7fa').rect(startX, y, pageW, 16).fill();
      doc.fillColor('#111').fontSize(9);
      headers.forEach((h,i)=>{
        doc.text(String(h||''), startX + i*colW + padX, y + padY, {width: colW - padX*2, align:'left'});
      });
      doc.restore();
      doc.strokeColor('#e1e5ea').lineWidth(1).moveTo(startX, y+16).lineTo(startX+pageW, y+16).stroke();
      doc.y = y + 18;
    }

    drawHeader();
    const statusStyleMap = {
      'IN_QUEUE': {label: arPdf('بالانتظار'), bg:'#f5f7fa', fg:'#1f2937'},
      'CALLED': {label: arPdf('تم النداء'), bg:'#e0f2fe', fg:'#075985'},
      'IN_SERVICE': {label: arPdf('قيد الخدمة'), bg:'#ffedd5', fg:'#9a3412'},
      'CLOSED_RESOLVED': {label: arPdf('مغلقة (تم الحل)'), bg:'#dcfce7', fg:'#166534'},
      'CLOSED_TRANSFERRED': {label: arPdf('مغلقة (تحويل)'), bg:'#e0e7ff', fg:'#3730a3'},
      'CLOSED_AWAITING': {label: arPdf('مغلقة (بانتظار)'), bg:'#fef9c3', fg:'#854d0e'},
      'CLOSED_NOT_RESOLVED': {label: arPdf('مغلقة (لم تُحل)'), bg:'#fee2e2', fg:'#991b1b'},
      'CLOSED_APPOINTMENT_BOOKED': {label: arPdf('مغلقة (موعد)'), bg:'#f3e8ff', fg:'#6b21a8'}
    };
    doc.fontSize(8).fillColor('#333');
    rows.forEach(r=>{
      // compute dynamic row height based on wrapped text
      const cells = r.map(c=> String(c==null?'':c));
      const heights = cells.map((txt)=> doc.heightOfString(txt, {width: colW - padX*2, align:'left'}));
      const rowH = Math.max(12, ...heights) + padY*2;

      if (doc.y + rowH > bottomLimit){
        doc.addPage();
        drawHeader();
      }

      const y = doc.y;
      // row separators
      doc.strokeColor('#eef0f3').lineWidth(1).moveTo(startX, y + rowH).lineTo(startX + pageW, y + rowH).stroke();

      cells.forEach((txt,i)=>{
        if (i === headers.length-1 && statusStyleMap[txt]){
          const st = statusStyleMap[txt];
          const bx = startX + i*colW + padX;
          const by = y + padY + 1;
          const bw = colW - padX*2;
          const bh = Math.min(14, rowH - padY*2 - 2);
          doc.save();
          doc.fillColor(st.bg).roundedRect(bx, by, bw, bh, 6).fill();
          doc.fillColor(st.fg).fontSize(8).text(st.label, bx, by+3, {width:bw, align:'center'});
          doc.restore();
        } else {
          doc.text(txt, startX + i*colW + padX, y + padY, {width: colW - padX*2, align:'left'});
        }
      });
      doc.y = y + rowH;
    });
  }

  // simple alias (kept for backwards compatibility)
  function simpleTable(headers, rows){
    return table(headers, rows);
  }

  if (type === 'feedback'){
    // Charts
    sectionTitle('تحليل التقييم', 'Feedback');
    const ratingBuckets = [0,0,0,0,0];
    let solvedYes=0, solvedNo=0;
    feedback.forEach(f=>{
      const r = Math.round(Number(f.employee_rating));
      if (r>=1 && r<=5) ratingBuckets[r-1]++;
      if (f.solved_yes_no===true) solvedYes++;
      else if (f.solved_yes_no===false) solvedNo++;
    });
    drawKpiCards([
      {label: 'Feedback / ' + arPdf('التقييمات'), value: totalFeedback},
      {label: 'Solved Yes', value: solvedYes},
      {label: 'Solved No', value: solvedNo},
      {label: 'Avg Rating', value: (feedback.length? (feedback.reduce((s,f)=> s+(Number(f.employee_rating)||0),0)/feedback.length).toFixed(2) : '-')}
    ]);
    drawBarChart('Rating Distribution (1–5)', ['1','2','3','4','5'], ratingBuckets, {maxBars:5});
    drawPieChart('Solved? / ' + arPdf('تم حل المشكلة؟'), ['Yes','No'], [solvedYes, solvedNo]);

    // Table
    doc.fontSize(13).fillColor('#111').text('Feedback Records', {align:'left'});
    doc.moveDown(0.4);
    const rows = feedback
      .slice()
      .sort((a,b)=> new Date(a.created_at)-new Date(b.created_at))
      .map(f=>{
        const t = db.tickets.find(x=>x.id===f.ticket_id);
        const c = db.counters.find(x=>x.id===f.counter_id);
        const u = db.users.find(x=>x.id===f.user_id);
        return [
          t ? t.ticket_code : (f.ticket_id||''),
          c ? c.name : '',
          u ? (u.full_name || u.username) : '',
          (f.solved_yes_no===true)?'Yes':(f.solved_yes_no===false?'No':''),
          f.employee_rating,
          (f.created_at||'').slice(0,19).replace('T',' ')
        ];
      });
    table(['Ticket','Counter','Employee','Solved','Rating','Time'], rows);
  } else if (type === 'employees'){
    sectionTitle('أداء الموظفين', 'Employees');
    // reuse CSV logic
    const byUser = new Map();
    tickets.forEach(t=>{
      if (!t.served_by_user_id) return;
      const row = byUser.get(t.served_by_user_id) || {served:0, closed:0, waitSum:0, waitN:0, serviceSum:0, serviceN:0, ratingsSum:0, ratingsN:0};
      row.served++;
      if (t.status==='CLOSED') row.closed++;
      if (t.called_at && t.created_at){
        const w = (new Date(t.called_at) - new Date(t.created_at))/1000;
        if (w>=0 && w<24*3600){ row.waitSum += w; row.waitN++; }
      }
      if (t.closed_at && t.in_service_at){
        const s = (new Date(t.closed_at) - new Date(t.in_service_at))/1000;
        if (s>=0 && s<24*3600){ row.serviceSum += s; row.serviceN++; }
      }
      byUser.set(t.served_by_user_id, row);
    });
    feedback.forEach(f=>{
      if (!f.user_id) return;
      const row = byUser.get(f.user_id) || {served:0, closed:0, waitSum:0, waitN:0, serviceSum:0, serviceN:0, ratingsSum:0, ratingsN:0};
      const r = Number(f.employee_rating);
      if (Number.isFinite(r)) { row.ratingsSum += r; row.ratingsN++; }
      byUser.set(f.user_id, row);
    });
    const rows = Array.from(byUser.entries()).map(([uid,row])=>{
      const u = db.users.find(x=>x.id===uid);
      return [
        u ? (u.full_name || u.username) : String(uid),
        row.served,
        row.closed,
        row.waitN ? Math.round((row.waitSum/row.waitN)/60) : '-',
        row.serviceN ? Math.round((row.serviceSum/row.serviceN)/60) : '-',
        row.ratingsN ? (row.ratingsSum/row.ratingsN).toFixed(2) : '-'
      ];
    }).sort((a,b)=> (Number(b[1])||0)-(Number(a[1])||0));

    // Charts: served by employee (Top 10)
    const top = rows.slice(0,10);
    drawBarChart('Served by Employee (Top 10)', top.map(r=>String(r[0]).slice(0,12)), top.map(r=>Number(r[1])||0));
    drawKpiCards([
      {label:'Employees', value: rows.length},
      {label:'Served', value: rows.reduce((s,r)=> s+(Number(r[1])||0),0)},
      {label:'Closed', value: rows.reduce((s,r)=> s+(Number(r[2])||0),0)},
      {label:'Avg Wait', value: (()=>{const ws=tickets.map(t=> (t.called_at&&t.created_at)?(new Date(t.called_at)-new Date(t.created_at))/1000:null).filter(v=>Number.isFinite(v)&&v>=0&&v<86400); return fmtMins(ws.reduce((a,b)=>a+b,0)/(ws.length||1));})()}
    ]);

    doc.fontSize(13).fillColor('#111').text('Employees Table', {align:'left'});
    doc.moveDown(0.4);
    table(['Employee','Served','Closed','Avg Wait (m)','Avg Service (m)','Avg Rating'], rows);

  } else if (type === 'status'){
    sectionTitle('ملخص الحالات', 'Ticket Status');
    const byStatus = new Map();
    tickets.forEach(t=>{
      const st = String(t.status||'NEW');
      byStatus.set(st, (byStatus.get(st)||0)+1);
    });
    const rows = Array.from(byStatus.entries()).sort((a,b)=>b[1]-a[1]).map(([st,cnt])=>[st, String(cnt)]);
    drawPieChart('Status Distribution', rows.map(r=>r[0]), rows.map(r=>Number(r[1])));
    drawBarChart('Status (Top)', rows.map(r=>r[0]), rows.map(r=>Number(r[1])));
    doc.fontSize(13).fillColor('#111').text('Status Table', {align:'left'});
    doc.moveDown(0.4);
    simpleTable(['Status','Count'], rows);
  } else if (type === 'services'){
    sectionTitle('ملخص الخدمات', 'Services');
    const byService = new Map();
    tickets.forEach(t=>{
      const sid = String(t.service_id||'');
      const name = (t.service_name_ar || (getService(t.service_id)?.name_ar) || '—');
      const row = byService.get(sid) || {id:t.service_id, name, total:0, closed:0};
      row.total++; if (t.status==='CLOSED') row.closed++;
      byService.set(sid, row);
    });
    const rows = Array.from(byService.values()).sort((a,b)=>b.total-a.total).map(r=>[String(r.id||''), r.name, String(r.total), String(r.closed)]);
    drawBarChart('Tickets by Service (Top 10)', rows.slice(0,10).map(r=> arPdf(r[1]).slice(0,12)), rows.slice(0,10).map(r=>Number(r[2])||0));
    doc.fontSize(13).fillColor('#111').text('Services Table', {align:'left'});
    doc.moveDown(0.4);
    simpleTable(['ID','Service','Total','Closed'], rows);
  } else if (type === 'counters'){
    sectionTitle('ملخص الكونترات', 'Counters');
    const byCounter = new Map();
    tickets.forEach(t=>{
      const cid = t.assigned_counter_id;
      const c = db.counters.find(x=>x.id===cid);
      const name = c ? c.name : 'غير محدد';
      const row = byCounter.get(String(cid||'null')) || {id:cid, name, total:0, closed:0};
      row.total++; if (t.status==='CLOSED') row.closed++;
      byCounter.set(String(cid||'null'), row);
    });
    const rows = Array.from(byCounter.values()).sort((a,b)=>b.total-a.total).map(r=>[String(r.id||''), r.name, String(r.total), String(r.closed)]);
    drawBarChart('Tickets by Counter (Top 10)', rows.slice(0,10).map(r=>String(r[1]).slice(0,12)), rows.slice(0,10).map(r=>Number(r[2])||0));
    doc.fontSize(13).fillColor('#111').text('Counters Table', {align:'left'});
    doc.moveDown(0.4);
    simpleTable(['ID','Counter','Total','Closed'], rows);

  } else {
    sectionTitle('التذاكر', 'Tickets');
    // Volume by hour
    const hours = Array.from({length:24}, (_,i)=>String(i).padStart(2,'0'));
    const hourCounts = new Array(24).fill(0);
    tickets.forEach(t=>{
      try{ const d = new Date(t.created_at); const h = d.getHours(); if (h>=0 && h<24) hourCounts[h]++; }catch(e){}
    });
    drawBarChart('Tickets by Hour', hours, hourCounts, {maxBars:24});
    // KPI cards
    const waits = tickets.map(t=> (t.called_at&&t.created_at)?(new Date(t.called_at)-new Date(t.created_at))/1000:null).filter(v=>Number.isFinite(v)&&v>=0&&v<86400);
    const services = tickets.map(t=> (t.closed_at&&t.in_service_at)?(new Date(t.closed_at)-new Date(t.in_service_at))/1000:null).filter(v=>Number.isFinite(v)&&v>=0&&v<86400);
    drawKpiCards([
      {label:'Tickets', value: totalTickets},
      {label:'Closed', value: closed},
      {label:'Avg Wait', value: fmtMins(waits.reduce((a,b)=>a+b,0)/(waits.length||1))},
      {label:'Avg Service', value: fmtMins(services.reduce((a,b)=>a+b,0)/(services.length||1))}
    ]);

    doc.fontSize(13).fillColor('#111').text('Tickets Table', {align:'left'});
    doc.moveDown(0.4);
    const rows = tickets
      .slice()
      .sort((a,b)=> new Date(a.created_at)-new Date(b.created_at))
      .map(t=>{
        const c = db.counters.find(x=>x.id===t.assigned_counter_id);
        const beneficiary = t.beneficiary || {};
        return [
          t.ticket_code,
          (t.service_name_ar || t.service_name || ''),
          beneficiary.full_name || '',
          beneficiary.national_id || '',
          beneficiary.phone || '',
          c ? c.name : '',
          t.status
        ];
      });
    table(['Ticket','Service','Name','National ID','Phone','Counter','Status'], rows);
  }

  // Approval block at the bottom (Arabic labels) — user preference: bottom of the report
  const report_meta = (db.settings && db.settings.report_meta) ? db.settings.report_meta : {};
  const metaPairs = [
    ['المشرف', normalizeNameOrder(report_meta.supervisor)],
    ['المُعدّ', normalizeNameOrder(report_meta.prepared_by)],
    ['المراجع', normalizeNameOrder(report_meta.reviewed_by)],
    ['المعتمد', normalizeNameOrder(report_meta.approved_by)],
    ['إصدار التقرير', report_meta.report_version]
  ].filter(([_,v])=> String(v||'').trim().length);

  if (metaPairs.length){
    const neededH = 90;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    if (doc.y + neededH > bottomLimit) doc.addPage();
    doc.moveDown(1);
    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const y = doc.y;
    doc.strokeColor('#d9dee5').lineWidth(1).moveTo(x, y).lineTo(x+w, y).stroke();
    doc.moveDown(0.6);
    doc.fontSize(11).fillColor('#111').text(arPdf('اعتماد التقرير'), {align:'right'});
    doc.moveDown(0.4);

    const colGap = 12;
    const colW = (w - colGap) / 2;
    let yy = doc.y;
    metaPairs.forEach(([label,val], idx)=>{
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const xx = x + col*(colW + colGap);
      const yyy = yy + row*18;
      doc.fontSize(9).fillColor('#555').text(arPdf(label + ':'), xx, yyy, {width: 70, align:'right'});
      doc.fontSize(9).fillColor('#111').text(arPdf(String(val||'')), xx, yyy, {width: colW, align:'right'});
    });
    doc.y = yy + (Math.ceil(metaPairs.length/2)*18) + 6;
  }

  doc.end();
});

// ---------------- Beneficiary history (Admin + Counter) ----------------
function normalizeDigits(str){
  return String(str||'').replace(/\D/g,'');
}

function beneficiaryKeyFromTicket(t){
  const b = t.beneficiary || {};
  const nid = normalizeDigits(b.national_id || t.national_id || '');
  const phone = normalizeDigits(b.phone || t.phone || '');
  const name = String(b.full_name || '').trim();
  return nid || phone || (name ? `name:${name}` : `ticket:${t.ticket_code||t.id}`);
}

function beneficiaryDisplayFromTicket(t){
  const b = t.beneficiary || {};
  return {
    full_name: String(b.full_name || '').trim(),
    national_id: normalizeDigits(b.national_id || t.national_id || ''),
    phone: normalizeDigits(b.phone || t.phone || ''),
  };
}


function ticketDisplayInfo(t){
  const counterId = t.assigned_counter_id || t.assigned_counter || (t.feedback ? t.feedback.counter_id : null);
  const counter = counterId ? (db.counters||[]).find(c=>String(c.id)===String(counterId)) : null;

  const empId = t.served_by_user_id || t.closed_by_user_id || (t.feedback ? t.feedback.user_id : null);
  const emp = empId ? (db.users||[]).find(u=>String(u.id)===String(empId)) : null;

  return {
    counter_name: counter ? counter.name : '',
    employee_name: emp ? emp.full_name : ''
  };
}

// Normalize Arabic full names if they were entered in "family first" order.
// Heuristic: for 2+ tokens, move the first token to the end.
function normalizeNameOrder(s){
  const str = String(s||'').trim();
  if (!str) return '';
  const parts = str.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return str;
  return parts.slice(1).concat(parts[0]).join(' ');
}

function findBeneficiaryTicketsByKey(key){
  const k = String(key||'').trim();
  const isNameKey = k.startsWith('name:');
  const nameVal = isNameKey ? k.slice(5) : '';
  const digits = normalizeDigits(k);
  return (db.tickets||[]).filter(t=>{
    const b = t.beneficiary || {};
    const nid = normalizeDigits(b.national_id || t.national_id || '');
    const phone = normalizeDigits(b.phone || t.phone || '');
    const name = String(b.full_name || '').trim();
    if (isNameKey) return nameVal && name === nameVal;
    if (digits) return (nid && nid===digits) || (phone && phone===digits);
    return false;
  });
}

// Beneficiary search pages
app.get('/admin/beneficiaries', requireAdmin, (req,res)=>{
  loadDb();
  const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
  const ui = (db.settings && db.settings.ui) ? db.settings.ui : {};
  res.render('beneficiaries_search', { user:req.session.admin_user, branding, ui, basePath:'/admin' });
});

app.get('/counter/beneficiaries', requireCounterLogin, (req,res)=>{
  loadDb();
  const branding = (db.settings && db.settings.branding) ? db.settings.branding : {};
  const ui = (db.settings && db.settings.ui) ? db.settings.ui : {};
  res.render('beneficiaries_search', { user:req.session.counter_user, branding, ui, basePath:'/counter' });
});

// Beneficiary detail pages (all cases in one page + print)
app.get('/admin/beneficiary/:key', requireAdmin, (req,res)=>{
  loadDb();
  const key = req.params.key;
  const tickets = findBeneficiaryTicketsByKey(key)
    .slice()
    .sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
  const feedbackByTicketId = Object.fromEntries((db.feedback||[]).map(f=>[String(f.ticket_id),f]));
  const casesByTicketId = Object.fromEntries((db.cases||[]).map(c=>[String(c.ticket_id), c]));
  const tickets_with_feedback = tickets.map(t=>({ ...t, feedback: feedbackByTicketId[String(t.id)] || null }));
  const tickets_enriched = tickets_with_feedback.map(t=>{
    const c = casesByTicketId[String(t.id)];
    return ({
      ...t,
      ...ticketDisplayInfo(t),
      case_summary: (c && c.summary) ? String(c.summary) : (t.summary||''),
      case_details: (c && c.details) ? String(c.details) : '',
      case_outcome: (c && c.outcome_code) ? String(c.outcome_code) : (t.status||'')
    });
  });
  const last_feedback = tickets_enriched.find(t=>t.feedback)?.feedback || null;
  const ratings = tickets_enriched.map(t=>t.feedback && typeof t.feedback.rating==='number' ? t.feedback.rating : null).filter(v=>v!==null);
  const summary = {
    total_tickets: tickets_enriched.length,
    closed_tickets: tickets_enriched.filter(t=> String(t.status||'').toUpperCase().includes('CLOSED')).length,
    last_counter: tickets_enriched.find(t=>t.counter_name)?.counter_name || '',
    last_employee: tickets_enriched.find(t=>t.employee_name)?.employee_name || '',
    avg_rating: ratings.length ? (ratings.reduce((a,b)=>a+b,0)/ratings.length) : null,
    ratings_count: ratings.length
  };
  res.render('beneficiary_detail', {
    user:req.session.admin_user,
    key,
    profile: tickets[0] ? beneficiaryDisplayFromTicket(tickets[0]) : {full_name:'',national_id:'',phone:''},
    tickets: tickets_enriched,
    last_feedback,
    summary,
    backUrl:'/admin/beneficiaries'
  });
});

app.get('/counter/beneficiary/:key', requireCounterLogin, (req,res)=>{
  loadDb();
  const key = req.params.key;
  const tickets = findBeneficiaryTicketsByKey(key)
    .slice()
    .sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
  const feedbackByTicketId = Object.fromEntries((db.feedback||[]).map(f=>[String(f.ticket_id),f]));
  const casesByTicketId = Object.fromEntries((db.cases||[]).map(c=>[String(c.ticket_id), c]));
  const tickets_with_feedback = tickets.map(t=>({ ...t, feedback: feedbackByTicketId[String(t.id)] || null }));
  const tickets_enriched = tickets_with_feedback.map(t=>{
    const c = casesByTicketId[String(t.id)];
    return ({
      ...t,
      ...ticketDisplayInfo(t),
      case_summary: (c && c.summary) ? String(c.summary) : (t.summary||''),
      case_details: (c && c.details) ? String(c.details) : '',
      case_outcome: (c && c.outcome_code) ? String(c.outcome_code) : (t.status||'')
    });
  });
  const last_feedback = tickets_enriched.find(t=>t.feedback)?.feedback || null;
  const ratings = tickets_enriched.map(t=>t.feedback && typeof t.feedback.rating==='number' ? t.feedback.rating : null).filter(v=>v!==null);
  const summary = {
    total_tickets: tickets_enriched.length,
    closed_tickets: tickets_enriched.filter(t=> String(t.status||'').toUpperCase().includes('CLOSED')).length,
    last_counter: tickets_enriched.find(t=>t.counter_name)?.counter_name || '',
    last_employee: tickets_enriched.find(t=>t.employee_name)?.employee_name || '',
    avg_rating: ratings.length ? (ratings.reduce((a,b)=>a+b,0)/ratings.length) : null,
    ratings_count: ratings.length
  };
  res.render('beneficiary_detail', {
    user:req.session.counter_user,
    key,
    profile: tickets[0] ? beneficiaryDisplayFromTicket(tickets[0]) : {full_name:'',national_id:'',phone:''},
    tickets: tickets_enriched,
    last_feedback,
    summary,
    backUrl:'/counter/beneficiaries'
  });
});

// Search API (requires any login)
app.get('/api/beneficiaries/search', requireAnyAuth, (req,res)=>{
  loadDb();
  const q = String(req.query.q||'').trim();
  const mode = String(req.query.mode||'auto').toLowerCase();
  if (!q) return res.json({ok:true, results:[]});

  const qDigits = normalizeDigits(q);
  const qLower = q.toLowerCase();

  let effective = mode;
  if (mode === 'auto'){
    if (qDigits && qDigits.length >= 8) effective = 'digits';
    else if (qDigits && qDigits.length < 8) effective = 'ticket';
    else effective = 'name';
  }

  // build candidate tickets
  let tickets = (db.tickets||[]);
  tickets = tickets.filter(t=>{
    const b = t.beneficiary || {};
    const nid = normalizeDigits(b.national_id || t.national_id || '');
    const phone = normalizeDigits(b.phone || t.phone || '');
    const name = String(b.full_name || '').toLowerCase();
    const code = String(t.ticket_code || t.id || '').toLowerCase();

    if (mode === 'nid') return !!qDigits && nid === qDigits;
    if (mode === 'phone') return !!qDigits && (phone === qDigits || phone.endsWith(qDigits));
    if (mode === 'ticket') return code.includes(qLower) || normalizeDigits(code) === qDigits;
    if (mode === 'name') return !!qLower && name.includes(qLower);

    // auto
    if (effective === 'digits'){
      return (nid && nid===qDigits) || (phone && (phone===qDigits || phone.endsWith(qDigits)));
    }
    if (effective === 'ticket'){
      return code.includes(qLower) || normalizeDigits(code) === qDigits;
    }
    // name
    return !!qLower && name.includes(qLower);
  });

  // aggregate per beneficiary key
  const map = new Map();
  for (const t of tickets){
    const key = beneficiaryKeyFromTicket(t);
    const disp = beneficiaryDisplayFromTicket(t);
    const cs = (db.cases||[]).find(x=>x.ticket_id===t.id);
    const cur = map.get(key) || {
      key,
      full_name: disp.full_name,
      national_id: disp.national_id,
      phone: disp.phone,
      count: 0,
      last_status: '',
      last_date: '',
      last_summary: ''
    };
    cur.count++;
    const dt = t.closed_at || t.created_at;
    if (!cur.last_date || new Date(dt) > new Date(cur.last_date)){
      cur.last_date = dt;
      cur.last_status = t.status || '';
      cur.last_summary = (cs && cs.summary) ? String(cs.summary) : (t.summary || '');
    }
    // keep best name/ids
    if (!cur.full_name && disp.full_name) cur.full_name = disp.full_name;
    if (!cur.national_id && disp.national_id) cur.national_id = disp.national_id;
    if (!cur.phone && disp.phone) cur.phone = disp.phone;
    map.set(key, cur);
  }

  const results = Array.from(map.values())
    .sort((a,b)=> (new Date(b.last_date) - new Date(a.last_date)))
    .slice(0, 100);
  // keep backward-compatible fields used by UI
  results.forEach(r=>{ r.last_updated_at = r.last_date; });
  res.json({ok:true, results});
});

// List beneficiaries without search (requires any login)
app.get('/api/beneficiaries/list', requireAnyAuth, (req,res)=>{
  loadDb();
  const range = String(req.query.range||'week').toLowerCase();
  const now = new Date();
  let days = 7;
  if (range==='day') days = 1;
  else if (range==='month') days = 30;
  else if (range==='year') days = 365;
  else if (range==='all') days = 3650;

  const cutoff = new Date(now.getTime() - days*24*60*60*1000);
  const ticketsAll = (db.tickets||[]);
  const tickets = ticketsAll.filter(t=>{
    const dt = t.closed_at || t.created_at;
    if (!dt) return false;
    return new Date(dt) >= cutoff;
  });

  const map = new Map();
  for (const t of tickets){
    const key = beneficiaryKeyFromTicket(t);
    const disp = beneficiaryDisplayFromTicket(t);
    const cs = (db.cases||[]).find(x=>x.ticket_id===t.id);
    const cur = map.get(key) || {
      key,
      full_name: disp.full_name,
      national_id: disp.national_id,
      phone: disp.phone,
      count: 0,
      last_status: '',
      last_date: '',
      last_summary: ''
    };
    cur.count++;
    const dt = t.closed_at || t.created_at;
    if (!cur.last_date || new Date(dt) > new Date(cur.last_date)){
      cur.last_date = dt;
      cur.last_status = t.status || '';
      cur.last_summary = (cs && cs.summary) ? String(cs.summary) : (t.summary || '');
    }
    if (!cur.full_name && disp.full_name) cur.full_name = disp.full_name;
    if (!cur.national_id && disp.national_id) cur.national_id = disp.national_id;
    if (!cur.phone && disp.phone) cur.phone = disp.phone;
    map.set(key, cur);
  }

  const results = Array.from(map.values())
    .sort((a,b)=> (new Date(b.last_date) - new Date(a.last_date)))
    .slice(0, 200);
  results.forEach(r=>{ r.last_updated_at = r.last_date; });
  res.json({ok:true, results});
});

app.post('/admin/counters/add', requireAdmin, (req,res)=>{
  loadDb();
  const {name, priority_order} = req.body;
  const id = db.counters.length ? Math.max(...db.counters.map(c=>c.id))+1 : 1;
  db.counters.push({id, name: name || `كونتر ${id}`, location:'', is_active:true, priority_order: Number(priority_order)||id});
  db.counter_daily.push({work_date: getWorkDate(), counter_id: id, enabled_today:true});

  // Per-counter overrides (optional)
  if (!db.settings.counter_overrides) db.settings.counter_overrides = {};
  (db.counters || []).forEach(c=>{
    const cid = String(c.id);
    const restKey = `counter_rest_${cid}`;
    const autoKey = `counter_auto_${cid}`;
    const restVal = req.body[restKey];
    const autoVal = req.body[autoKey];

    if (!db.settings.counter_overrides[cid]) db.settings.counter_overrides[cid] = { rest_seconds: null, auto_call_enabled: null };
    const ov = db.settings.counter_overrides[cid];

    // rest seconds: empty => null (use default)
    if (restVal === '' || restVal == null){
      ov.rest_seconds = null;
    } else {
      const rr = Number(restVal);
      ov.rest_seconds = Number.isFinite(rr) ? clampInt(rr, db.settings.rest_seconds_min, db.settings.rest_seconds_max) : null;
    }

    // auto: default|on|off
    const av = String(autoVal || 'default').toLowerCase();
    if (av === 'on' || av === 'true' || av === '1') ov.auto_call_enabled = true;
    else if (av === 'off' || av === 'false' || av === '0') ov.auto_call_enabled = false;
    else ov.auto_call_enabled = null;
  });

  saveDb();
  res.redirect('/admin');
});

app.post('/admin/counters/toggle', requireAdmin, (req,res)=>{
  loadDb();
  const {counter_id, enabled_today} = req.body;
  const workDate = getWorkDate();
  let row = db.counter_daily.find(x=>x.work_date===workDate && x.counter_id===Number(counter_id));
  if (!row){
    row = {work_date, counter_id:Number(counter_id), enabled_today:true};
    db.counter_daily.push(row);
  }
  row.enabled_today = (String(enabled_today)==='true');
  saveDb();
  res.redirect('/admin');
});

app.post('/admin/counters/update', requireAdmin, (req,res)=>{
  loadDb();
  const {counter_id, name, priority_order, is_active} = req.body;
  const c = db.counters.find(x=>x.id===Number(counter_id));
  if (c){
    c.name = name || c.name;
    c.priority_order = Number(priority_order) || c.priority_order;
    c.is_active = (String(is_active)==='true');
  }
  saveDb();
  res.redirect('/admin');
});

app.post('/admin/services/add', requireAdmin, (req,res)=>{
  loadDb();
  const {name_ar, name_en, type, code_prefix, kiosk_visible, availability_mode, availability_weekday} = req.body;
  const id = db.services.length ? Math.max(...db.services.map(s=>s.id))+1 : 1;
  db.services.push({
    id,
    name_ar: name_ar || `خدمة ${id}`,
    name_en: name_en || `Service ${id}`,
    type: (type==='appointment')?'appointment':'walkin',
    code_prefix: code_prefix || null,
    kiosk_visible: String(kiosk_visible)==='true',
    is_active: true,
    availability_mode: availability_mode || 'always',
    availability_weekday: (availability_weekday!=='' && availability_weekday!=null) ? Number(availability_weekday) : null
  });
  saveDb();
  res.redirect('/admin');
});

app.post('/admin/services/update', requireAdmin, (req,res)=>{
  loadDb();
  const {service_id, name_ar, name_en, type, code_prefix, kiosk_visible, is_active, availability_mode, availability_weekday} = req.body;
  const s = db.services.find(x=>x.id===Number(service_id));
  if (s){
    s.name_ar = name_ar || s.name_ar;
    s.name_en = name_en || s.name_en || s.name_ar;
    s.type = (type==='appointment')?'appointment':'walkin';
    s.code_prefix = code_prefix || null;
    s.kiosk_visible = (String(kiosk_visible)==='true');
    s.is_active = (String(is_active)==='true');
    s.availability_mode = availability_mode || 'always';
    s.availability_weekday = (availability_weekday!=='' && availability_weekday!=null) ? Number(availability_weekday) : null;
  }
  saveDb();
  res.redirect('/admin');
});

// Services delete (safe delete): disable service to preserve reports/tickets history
app.post('/admin/services/delete', requireAdmin, (req,res)=>{
  loadDb();
  const {service_id} = req.body;
  const sid = Number(service_id);
  const s = db.services.find(x=>x.id===sid);
  if (s){
    s.is_active = false;
    s.kiosk_visible = false;
    if (s.name_ar && !String(s.name_ar).includes('محذوف')) s.name_ar = `${s.name_ar} (محذوف)`;
    if (db.settings && db.settings.service_counter_map){
      delete db.settings.service_counter_map[String(sid)];
    }
    // Remove from users allowed lists (if stored explicitly)
    if (Array.isArray(db.users)){
      db.users.forEach(u=>{
        if (Array.isArray(u.allowed_service_ids) && u.allowed_service_ids.length){
          u.allowed_service_ids = u.allowed_service_ids.filter(x=>Number(x)!==sid);
        }
      });
    }
    saveDb();
  }
  res.redirect('/admin');
});

// Service routing: map service -> preferred counter (employee)
app.post('/admin/service-routing/update', requireAdmin, (req,res)=>{
  loadDb();
  const { service_id, counter_id } = req.body;
  const sid = Number(service_id);
  const cid = (counter_id==='' || counter_id==null) ? null : Number(counter_id);
  if (!db.settings.service_counter_map) db.settings.service_counter_map = {};
  if (Number.isFinite(sid)){
    if (cid==null || !Number.isFinite(cid)) delete db.settings.service_counter_map[String(sid)];
    else db.settings.service_counter_map[String(sid)] = cid;
    saveDb();
  }
  res.redirect('/admin#routing');
});

app.post('/admin/settings/update', requireAdmin, (req,res)=>{
  loadDb();
  const {
    rest_seconds_default,
    auto_call_enabled,
    feedback_mode,
    appointments_weekday,
    appointments_slot_minutes,
    ui_theme,
    kiosk_return_seconds,
    kiosk_auto_print,
    kiosk_printing_mode,
    sound_enabled,
    sound_chime,
    sound_chime_style,
    sound_chime_volume,
    sound_mode,
    sound_speak_ar,
    sound_speak_en,
    sound_voice_gender_ar,
    sound_voice_gender_en,
    sound_phrase_ar,
    sound_phrase_en,
    work_hours_enabled,
    work_start_time,
    work_end_time,
    work_days,
    kiosk_languages,
    student_uni_enabled,
    student_uni_qr_text,
    student_uni_msg_ar,
    student_uni_msg_en,
    student_uni_msg_fr,
    student_uni_msg_zh
  } = req.body;
  const r = Number(rest_seconds_default);
  if (Number.isFinite(r)) db.settings.rest_seconds_default = r;
  db.settings.auto_call_enabled = (String(auto_call_enabled)==='true');

  // Feedback mode: shared (single exit device) or per_counter
  const fm = String(feedback_mode || db.settings.feedback_mode || 'shared');
  db.settings.feedback_mode = (fm === 'per_counter') ? 'per_counter' : 'shared';

  // UI settings
  if (!db.settings.ui) db.settings.ui = { theme:'dark', kiosk_return_seconds:10, kiosk_auto_print:true, kiosk_printing_mode:'browser', kiosk_show_fullscreen_hint:true };
  if (ui_theme){
    const t = String(ui_theme).toLowerCase();
    const allowed = new Set([
      'dark','navy','teal','slate',
      // Light themes (>=10)
      'sand','light','mist','mint','sky','lavender','rose','stone','ivory','pearl'
    ]);
    db.settings.ui.theme = allowed.has(t) ? t : 'dark';
  }
  const kr = Number(kiosk_return_seconds);
  if (Number.isFinite(kr) && kr >= 3 && kr <= 60) db.settings.ui.kiosk_return_seconds = kr;
  db.settings.ui.kiosk_auto_print = (String(kiosk_auto_print)==='true');
  if (kiosk_printing_mode) db.settings.ui.kiosk_printing_mode = (String(kiosk_printing_mode)==='chrome_kiosk') ? 'chrome_kiosk' : 'browser';

  
  // Kiosk languages (from admin settings)
  const allowedLangs = ['ar','en','zh','fr'];
  let langs = kiosk_languages;
  if (typeof langs === 'string') langs = [langs];
  if (!Array.isArray(langs)) langs = null;
  if (!db.settings.ui) db.settings.ui = { theme:'dark', kiosk_return_seconds:10, kiosk_auto_print:true, kiosk_printing_mode:'browser', kiosk_show_fullscreen_hint:true };
  if (langs && langs.length){
    const cleaned = langs.map(x=>String(x).toLowerCase().trim()).filter(x=>allowedLangs.includes(x));
    db.settings.ui.kiosk_languages = cleaned.length ? cleaned : ['ar','en'];
  } else if (!db.settings.ui.kiosk_languages){
    db.settings.ui.kiosk_languages = ['ar','en','zh'];
  }

  // Student university message + QR (kiosk)
  const STUDENT_UNI_QR_DEFAULT = 'https://www.google.com/maps/place/%D9%88%D8%B2%D8%A7%D8%B1%D8%A9+%D8%A7%D9%84%D8%AA%D8%B9%D9%84%D9%8A%D9%85%E2%80%AD/@24.6624422,46.6884679,17z/data=!4m9!1m2!2m1!1z2YjZg9in2YTYqSDYp9mE2KrYudmE2YrZhSDYp9mE2KzYp9mF2LnZig!3m5!1s0x3e2f05f5dcd9f36d:0x939254fa8dded8a7!8m2!3d24.6618582!4d46.6851764!16s%2Fg%2F11h_w1vy9k!5m1!1e4?entry=ttu';
  if (!db.settings.ui.student_university) db.settings.ui.student_university = {enabled:true, qr_text:STUDENT_UNI_QR_DEFAULT, message_ar:"", message_en:"", message_fr:"", message_zh:""};
  // Keep a sensible default QR if the field is left empty.
  try{
    if (db.settings.ui.student_university && db.settings.ui.student_university.enabled && !String(db.settings.ui.student_university.qr_text||'').trim()){
      db.settings.ui.student_university.qr_text = STUDENT_UNI_QR_DEFAULT;
    }
  }catch(e){}
  if (student_uni_enabled !== undefined){
    db.settings.ui.student_university.enabled = (String(student_uni_enabled)==="true");
  }
  if (student_uni_qr_text !== undefined){
    db.settings.ui.student_university.qr_text = String(student_uni_qr_text||"").trim();
  }
  if (student_uni_msg_ar !== undefined) db.settings.ui.student_university.message_ar = String(student_uni_msg_ar||"");
  if (student_uni_msg_en !== undefined) db.settings.ui.student_university.message_en = String(student_uni_msg_en||"");
  if (student_uni_msg_fr !== undefined) db.settings.ui.student_university.message_fr = String(student_uni_msg_fr||"");
  if (student_uni_msg_zh !== undefined) db.settings.ui.student_university.message_zh = String(student_uni_msg_zh||"");

// Sound settings
  if (!db.settings.ui.sound){
    db.settings.ui.sound = {
      enabled:true, chime:true,
      chime_style:'alarm',
      chime_volume: 0.85,
      mode: 'tts',
      speak_ar:true, speak_en:true,
      voice_gender_ar: 'auto', voice_gender_en: 'auto',
      phrase_ar:'الرقم {ticket}، تفضل إلى {counter}',
      phrase_en:'Ticket {ticket}, please go to {counter}'
    };
  }
  if (db.settings.ui.sound.mode===undefined) db.settings.ui.sound.mode = 'tts';
  if (db.settings.ui.sound.chime_style===undefined) db.settings.ui.sound.chime_style='alarm';
  if (db.settings.ui.sound.chime_volume===undefined) db.settings.ui.sound.chime_volume=0.85;

  db.settings.ui.sound.enabled = (String(sound_enabled)==='true');
  db.settings.ui.sound.chime = (String(sound_chime)==='true');
  const cs = String(sound_chime_style||'alarm').toLowerCase();
  db.settings.ui.sound.chime_style = (cs==='alarm' || cs==='bell' || cs==='airport') ? cs : 'alarm';
  const cv = Number(sound_chime_volume);
  if (Number.isFinite(cv) && cv>=0 && cv<=1) db.settings.ui.sound.chime_volume = cv;

  const smode = String(sound_mode||'tts').toLowerCase();
  db.settings.ui.sound.mode = (smode==='recordings') ? 'recordings' : 'tts';
  db.settings.ui.sound.speak_ar = (String(sound_speak_ar)==='true');
  db.settings.ui.sound.speak_en = (String(sound_speak_en)==='true');
  const vga = String(sound_voice_gender_ar||'auto').toLowerCase();
  const vge = String(sound_voice_gender_en||'auto').toLowerCase();
  db.settings.ui.sound.voice_gender_ar = (vga==='male'||vga==='female') ? vga : 'auto';
  db.settings.ui.sound.voice_gender_en = (vge==='male'||vge==='female') ? vge : 'auto';
  const pa = String(sound_phrase_ar||'').trim();
  const pe = String(sound_phrase_en||'').trim();
  if (pa) db.settings.ui.sound.phrase_ar = pa;
  if (pe) db.settings.ui.sound.phrase_en = pe;

  const ap_wd = Number(appointments_weekday);
  if (Number.isFinite(ap_wd)) db.settings.appointments.weekday = ap_wd;
  const sm = Number(appointments_slot_minutes);
  if (Number.isFinite(sm)) db.settings.appointments.slot_minutes = sm;

  // Work hours
  if (!db.settings.work_hours) db.settings.work_hours = { enabled:false, start_time:'07:30', end_time:'14:30', days:[0,1,2,3,4] };
  db.settings.work_hours.enabled = (String(work_hours_enabled)==='true');
  if (work_start_time && /^\d{1,2}:\d{2}$/.test(String(work_start_time))) db.settings.work_hours.start_time = String(work_start_time);
  if (work_end_time && /^\d{1,2}:\d{2}$/.test(String(work_end_time))) db.settings.work_hours.end_time = String(work_end_time);

  // Weekdays (checkboxes) — accept string or array
  let workDays = work_days;
  if (typeof workDays === 'string') workDays = [workDays];
  if (Array.isArray(workDays)){
    const cleaned = workDays.map(x=>Number(x)).filter(x=>Number.isFinite(x) && x>=0 && x<=6);
    // If nothing selected, keep previous or default to Sun-Thu
    db.settings.work_hours.days = cleaned.length ? Array.from(new Set(cleaned)) : (Array.isArray(db.settings.work_hours.days) && db.settings.work_hours.days.length ? db.settings.work_hours.days : [0,1,2,3,4]);
  }

  saveDb();
  res.redirect('/admin');
});

// =========================
// Backup & Restore (Admin)
// =========================
function ensureDir(p){
  try{ if (!fs.existsSync(p)) fs.mkdirSync(p, {recursive:true}); }catch(e){}
}

function buildBackupZip(){
  const zip = new AdmZip();

  // Always include DB
  if (fs.existsSync(DB_PATH)) zip.addLocalFile(DB_PATH, 'data');

  // Optional assets
  const voicepackDir = path.join(__dirname, 'public', 'voicepack');
  const soundsDir = path.join(__dirname, 'public', 'sounds');
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  if (fs.existsSync(voicepackDir)) zip.addLocalFolder(voicepackDir, 'public/voicepack');
  if (fs.existsSync(soundsDir)) zip.addLocalFolder(soundsDir, 'public/sounds');
  if (fs.existsSync(uploadsDir)) zip.addLocalFolder(uploadsDir, 'public/uploads');

  // Meta
  const meta = {
    app: 'beneficiaries-counter-system',
    created_at: new Date().toISOString(),
    includes: ['data/db.json','public/voicepack','public/sounds','public/uploads']
  };
  zip.addFile('backup_meta.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
  return zip;
}

app.get('/admin/backup/download.zip', requireAdmin, (req,res)=>{
  loadDb();
  const backupsDir = path.join(__dirname, 'data', 'backups');
  ensureDir(backupsDir);
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const filename = `backup_${ts}.zip`;
  const zip = buildBackupZip();

  // Keep a copy as an on-disk snapshot (optional)
  try{
    const fp = path.join(backupsDir, filename);
    zip.writeZip(fp);
  }catch(e){ /* ignore */ }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(zip.toBuffer());
});

app.post('/admin/backup/restore', requireAdmin, upload.single('backup_zip'), (req,res)=>{
  try{
    if (!req.file || !req.file.path) return res.status(400).send('Missing backup file');

    const backupsDir = path.join(__dirname, 'data', 'backups');
    ensureDir(backupsDir);

    // Snapshot current state before restore
    try{
      const ts = new Date().toISOString().replace(/[:.]/g,'-');
      const before = buildBackupZip();
      before.writeZip(path.join(backupsDir, `before_restore_${ts}.zip`));
    }catch(e){ /* ignore */ }

    const zip = new AdmZip(req.file.path);
    const ts2 = new Date().toISOString().replace(/[:.]/g,'-');
    const tmpDir = path.join(__dirname, 'data', `_restore_${ts2}`);
    ensureDir(tmpDir);
    zip.extractAllTo(tmpDir, true);

    const srcDb = path.join(tmpDir, 'data', 'db.json');
    if (!fs.existsSync(srcDb)){
      // allow legacy format
      const alt = path.join(tmpDir, 'db.json');
      if (fs.existsSync(alt)){
        ensureDir(path.dirname(DB_PATH));
        fs.copyFileSync(alt, DB_PATH);
      } else {
        return res.status(400).send('Invalid backup: missing data/db.json');
      }
    } else {
      ensureDir(path.dirname(DB_PATH));
      fs.copyFileSync(srcDb, DB_PATH);
    }

    // Restore optional assets (replace if present)
    const restoreFolders = [
      {src: path.join(tmpDir, 'public', 'voicepack'), dst: path.join(__dirname, 'public', 'voicepack')},
      {src: path.join(tmpDir, 'public', 'sounds'), dst: path.join(__dirname, 'public', 'sounds')},
      {src: path.join(tmpDir, 'public', 'uploads'), dst: path.join(__dirname, 'public', 'uploads')}
    ];
    restoreFolders.forEach(({src,dst})=>{
      if (!fs.existsSync(src)) return;
      ensureDir(path.dirname(dst));
      try{
        // Node 16+ supports fs.cpSync
        if (fs.existsSync(dst)) fs.rmSync(dst, {recursive:true, force:true});
        fs.cpSync(src, dst, {recursive:true});
      }catch(e){
        // Fallback: best-effort copy (shallow)
        ensureDir(dst);
      }
    });

    // Clean temp & uploaded file
    try{ fs.rmSync(tmpDir, {recursive:true, force:true}); }catch(e){}
    try{ fs.unlinkSync(req.file.path); }catch(e){}

    // Reload DB in memory
    loadDb();
    res.redirect('/admin');
  }catch(err){
    console.error(err);
    res.status(500).send('Restore failed');
  }
});

// Admin Users (Employees)
app.post('/admin/users/add', requireAdmin, (req,res)=>{
  loadDb();
  const {username, password, full_name, role, is_active, fixed_counter_id} = req.body;
  const service_ids = req.body.service_ids;
  const u = String(username||'').trim();
  if (!u) return res.redirect('/admin');
  if (db.users.some(x=>x.username===u)) return res.status(400).send('Username already exists');
  const id = db.users.length ? Math.max(...db.users.map(x=>x.id))+1 : 1;
  const r = (role==='admin') ? 'admin' : ((role==='supervisor') ? 'supervisor' : 'counter');

  // Normalize counter/services (only meaningful for counter role)
  let fixed = null;
  if (r==='counter'){
    const cid = Number(fixed_counter_id);
    fixed = Number.isFinite(cid) && cid>0 ? cid : null;
  }
  let allowed = null;
  if (r==='counter'){
    const arr = Array.isArray(service_ids) ? service_ids : (service_ids ? [service_ids] : []);
    const norm = arr.map(x=>Number(x)).filter(n=>Number.isFinite(n));
    // If all services are selected, store [] to mean "all" (cleaner & future-proof)
    const totalServices = Array.isArray(db.services) ? db.services.length : 0;
    allowed = (totalServices>0 && norm.length===totalServices) ? [] : (norm.length ? norm : []);
  }
  db.users.push({
    id,
    username: u,
    password: String(password||'1234'),
    full_name: String(full_name||u),
    role: r,
    is_active: String(is_active)==='true',
    fixed_counter_id: fixed,
    allowed_service_ids: allowed
  });
  saveDb();
  res.redirect('/admin');
});

app.post('/admin/users/update', requireAdmin, (req,res)=>{
  loadDb();
  const {user_id, username, password, full_name, role, is_active, fixed_counter_id} = req.body;
  const service_ids = req.body.service_ids;
  const id = Number(user_id);
  const user = db.users.find(x=>x.id===id);
  if (!user) return res.redirect('/admin');

  const newUsername = String(username||'').trim();
  if (newUsername && newUsername !== user.username){
    if (db.users.some(x=>x.username===newUsername && x.id!==id)) return res.status(400).send('Username already exists');
    user.username = newUsername;
  }
  const pw = String(password||'').trim();
  if (pw) user.password = pw;
  user.full_name = String(full_name||user.full_name);
  user.role = (role==='admin') ? 'admin' : ((role==='supervisor') ? 'supervisor' : 'counter');
  user.is_active = String(is_active)==='true';

  // Update counter assignment / allowed services (only if role is counter)
  if (user.role === 'counter'){
    const cid = Number(fixed_counter_id);
    user.fixed_counter_id = Number.isFinite(cid) && cid>0 ? cid : null;
    const arr = Array.isArray(service_ids) ? service_ids : (service_ids ? [service_ids] : null);
    if (arr){
      const norm = arr.map(x=>Number(x)).filter(n=>Number.isFinite(n));
      const totalServices = Array.isArray(db.services) ? db.services.length : 0;
      user.allowed_service_ids = (totalServices>0 && norm.length===totalServices) ? [] : (norm.length ? norm : []);
    }else{
      // if not provided, keep existing
      if (!Array.isArray(user.allowed_service_ids)) user.allowed_service_ids = [];
    }
  }else{
    // non-counter roles: clear to avoid confusion
    user.fixed_counter_id = null;
    user.allowed_service_ids = [];
  }
  saveDb();
  res.redirect('/admin');
});


function applyUpdatePayload(payload, note){
  if (!payload || typeof payload !== 'object') return {ok:false, msg:'Invalid payload'};
  if (!db.system) db.system = {version:'0.2.0', last_update_at:null, last_update_note:null};

  if (payload.settings && typeof payload.settings === 'object'){
    db.settings = { ...db.settings, ...payload.settings };
    // nested appointments merge
    if (payload.settings.appointments && typeof payload.settings.appointments === 'object'){
      db.settings.appointments = { ...db.settings.appointments, ...payload.settings.appointments };
    }
  }

  if (Array.isArray(payload.services)){
    // Upsert by id, allow add/remove toggling
    payload.services.forEach(s=>{
      if (!s || s.id == null) return;
      const id = Number(s.id);
      if (!Number.isFinite(id)) return;
      const cur = db.services.find(x=>x.id===id);
      const normalized = {
        id,
        name_ar: s.name_ar || (cur && cur.name_ar) || `خدمة ${id}`,
        name_en: s.name_en || (cur && cur.name_en) || (s.name_ar || (cur && cur.name_ar) || `Service ${id}`),
        type: (s.type==='appointment') ? 'appointment' : 'walkin',
        code_prefix: s.code_prefix ?? (cur ? cur.code_prefix : null),
        kiosk_visible: (s.kiosk_visible == null) ? (cur ? cur.kiosk_visible : true) : !!s.kiosk_visible,
        is_active: (s.is_active == null) ? (cur ? cur.is_active : true) : !!s.is_active,
        availability_mode: s.availability_mode || (cur && cur.availability_mode) || 'always',
        availability_weekday: (s.availability_weekday == null) ? (cur ? cur.availability_weekday : null) : Number(s.availability_weekday)
      };
      if (cur) Object.assign(cur, normalized);
      else db.services.push(normalized);
    });
  }

  if (Array.isArray(payload.counters)){
    payload.counters.forEach(c=>{
      if (!c || c.id == null) return;
      const id = Number(c.id);
      if (!Number.isFinite(id)) return;
      const cur = db.counters.find(x=>x.id===id);
      const normalized = {
        id,
        name: c.name || (cur && cur.name) || `كونتر ${id}`,
        location: c.location || (cur && cur.location) || '',
        is_active: (c.is_active == null) ? (cur ? cur.is_active : true) : !!c.is_active,
        priority_order: Number.isFinite(Number(c.priority_order)) ? Number(c.priority_order) : (cur ? cur.priority_order : id)
      };
      if (cur) Object.assign(cur, normalized);
      else db.counters.push(normalized);
    });
  }

  db.system.last_update_at = new Date().toISOString();
  db.system.last_update_note = note || payload.note || null;
  saveDb();
  return {ok:true};
}

app.get('/admin/updates', requireAdmin, (req,res)=>{
  loadDb();
  const flash = req.session._flash_update || null;
  req.session._flash_update = null;
  res.render('admin_updates', { user:req.session.admin_user, system: db.system || {}, flash });
});

app.post('/admin/updates/apply', requireAdmin, upload.single('update_file'), (req,res)=>{
  loadDb();
  try {
    const note = (req.body && req.body.note) ? String(req.body.note) : '';

    // Option 1: JSON pasted
    if (req.body && req.body.update_json && String(req.body.update_json).trim()){
      const payload = JSON.parse(String(req.body.update_json));
      const r = applyUpdatePayload(payload, note);
      req.session._flash_update = r.ok ? {ok:true, msg:'تم تطبيق تحديث البيانات بنجاح.'} : {ok:false, msg:r.msg};
      return res.redirect('/admin/updates');
    }

    // Option 2: file upload (.json or .zip)
    if (!req.file){
      req.session._flash_update = {ok:false, msg:'لم يتم رفع ملف تحديث أو لصق JSON.'};
      return res.redirect('/admin/updates');
    }

    const fp = req.file.path;
    const orig = (req.file.originalname || '').toLowerCase();

    if (orig.endsWith('.json')){
      const payload = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const r = applyUpdatePayload(payload, note);
      req.session._flash_update = r.ok ? {ok:true, msg:'تم تطبيق ملف التحديث (JSON) بنجاح.'} : {ok:false, msg:r.msg};
      fs.unlinkSync(fp);
      return res.redirect('/admin/updates');
    }

    if (orig.endsWith('.zip')){
      const zip = new AdmZip(fp);
      const entries = zip.getEntries();

      // 1) apply update.json if present
      const updateEntry = entries.find(e=>e.entryName.toLowerCase().endsWith('update.json'));
      if (updateEntry){
        const payload = JSON.parse(updateEntry.getData().toString('utf8'));
        applyUpdatePayload(payload, note);
      }

      // 2) optional UI patches: public/* and views/*
      const safeRoots = new Set(['public/', 'views/']);
      for (const e of entries){
        if (e.isDirectory) continue;
        const name = e.entryName.replace(/\\/g,'/');
        if (name.includes('..')) continue;
        if (![...safeRoots].some(r=>name.startsWith(r))) continue;
        const outPath = path.join(__dirname, name);
        fs.mkdirSync(path.dirname(outPath), {recursive:true});
        fs.writeFileSync(outPath, e.getData());
      }

      fs.unlinkSync(fp);
      req.session._flash_update = {ok:true, msg:'تم تطبيق حزمة التحديث. إذا كان التحديث يحتوي تغييرات عميقة في السيرفر قد تحتاج إعادة تشغيل الخدمة.'};
      return res.redirect('/admin/updates');
    }

    fs.unlinkSync(fp);
    req.session._flash_update = {ok:false, msg:'نوع الملف غير مدعوم. استخدم JSON أو ZIP.'};
    return res.redirect('/admin/updates');
  } catch (e){
    try { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(_){ }
    req.session._flash_update = {ok:false, msg:'فشل تطبيق التحديث: ' + (e.message || String(e))};
    return res.redirect('/admin/updates');
  }
});

// Global error handler: prefer JSON for AJAX/JSON requests to avoid HTML error pages breaking fetch.
app.use((err, req, res, next)=>{
  try{
    const a = String(req.headers['accept'] || '');
    const ct = String(req.headers['content-type'] || '');
    const wantsJson = a.includes('application/json') || ct.includes('application/json') || req.xhr;
    if (wantsJson){
      return res.status(500).json({ok:false, msg:'خطأ في الخادم أثناء تنفيذ العملية.', detail: (err && err.message) ? err.message : String(err)});
    }
  }catch(e){}
  return res.status(500).send('Server error');
});

app.listen(PORT, ()=>{
  loadDb();
  console.log(`Running on http://localhost:${PORT}`);
});
// Express error handler (keep near the bottom)
app.use((err, req, res, next) => {
  console.error('ERR:', err && err.stack ? err.stack : err);
  return res.status(500).send('Server error');
});
// Express error handler (keep near the bottom)
app.use((err, req, res, next) => {
  console.error('ERR:', err && err.stack ? err.stack : err);
  return res.status(500).send('Server error');
});
