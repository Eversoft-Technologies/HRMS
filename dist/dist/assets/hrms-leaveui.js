/**
 * hrms-leaveui.js — the Leave Management page (/employees/leave).
 *
 * This page used to live inside the minified Vite bundle as function r0().
 * It was moved out so that Leave work no longer edits index-DCh6bk0Rv4.js,
 * where every change lands on a single 600KB line and is unmergeable when
 * two people work in parallel.
 *
 * How it hooks up
 * ---------------
 * The bundle keeps a seam:
 *
 *     function r0(){
 *       if(!window.__hrmsUI) window.__hrmsUI={g:g,n:n,B:B,...};
 *       return (window.__hrmsLeavePage||_r0Builtin)();
 *     }
 *
 * - __hrmsUI is published LAZILY, at first render, so this file never depends
 *   on script load order. Read it inside the component, never at load time.
 * - The seam re-reads __hrmsLeavePage on EVERY render, so if this file loads
 *   late React picks it up on the next render.
 * - If this file fails to load, the bundle falls back to _r0Builtin (a verbatim
 *   copy of this page) and the app keeps working. Never reference a bundle
 *   global directly: l0() does that with HRAreaChart, which is undefined, and
 *   /ai-analytics renders blank as a result.
 *
 * Contracts hrms-perms.js depends on — do not break these:
 * - the requests list stays a real <table> with <thead><tr> and 7 cells per
 *   body row; the expanded detail row stays a single colSpan=7 cell
 * - the approve button's visible text stays exactly "Approve"
 * - both action buttons keep data-perm="leave.approve" / "leave.reject"
 * Also: POST /api/leave and PUT /api/leave/<id> send fromDate/toDate as raw
 * ISO yyyy-mm-dd, and sorting compares the raw ISO strings (dd-mm-yyyy is
 * display only).
 */
(function () {
  'use strict';

  window.__hrmsLeavePage = function () {
    // Read the bundle's React + UI primitives at RENDER time, not load time.
    var U = window.__hrmsUI;
    var g = U.g, n = U.n, B = U.B, Us = U.Us, Gn = U.Gn, Hs = U.Hs, le = U.le,
        cn = U.cn, Qe = U.Qe, Bt = U.Bt, Vs = U.Vs, Dr = U.Dr, Et = U.Et;
    const[L,sL]=g.useState([]),[ld,sld]=g.useState(!0),[er,ser]=g.useState(""),[wr,swr]=g.useState(""),[op,so]=g.useState(!1),[bz,sb]=g.useState(!1),[fm,sf]=g.useState({type:"Casual Leave",fromDate:"",toDate:"",reason:""}),[fe,sfe]=g.useState(""),[q,sq]=g.useState(""),[flt,sflt]=g.useState("All"),[srt,ssrt]=g.useState("newest"),[bal,sbal]=g.useState([]),[exp,sexp]=g.useState(null),[cf,scf]=g.useState(null),[more,smore]=g.useState({}),[hd,shd]=g.useState(null),[per,sper]=g.useState("today");
    /* Missed Clock-Out — cor holds the correction requests: MY own normally,
       everyone's once appr resolves true. The mop/mfm/mfe/mbz quartet mirrors
       op/fm/fe/bz on the Apply Leave form; crj/crn/cre mirror cf on its
       decline modal. */
    const[cor,scor]=g.useState([]),[cop,scop]=g.useState(!1),[mop,smo]=g.useState(!1),[mfm,smf]=g.useState({date:"",time:"",reason:""}),[mfe,smfe]=g.useState(""),[mbz,smb]=g.useState(!1),[mAtt,smAtt]=g.useState(null),[mLd,smLd]=g.useState(!1);
    /* isAp, not `appr` — that name is already taken further down by the
       approved-leave array (var appr=byStatus("Approved")). */
    /* cexp is deliberately separate from the leave table's `exp`: both hold a
       bare row id, and a correction id can collide with a leave id, which
       would expand a row in the other list at the same time. */
    const[isAp,sIsAp]=g.useState(!1),[cflt,scflt]=g.useState("Pending"),[crj,scrj]=g.useState(null),[crn,scrn]=g.useState(""),[cre,scre]=g.useState(""),[cexp,scexp]=g.useState(null);

  /* ---- session + fetch helpers ---- */
  var sess=function(){try{return JSON.parse(localStorage.getItem("hrms_session")||"{}")}catch(_){return{}}};
  var readJson=function(x){return x.json().then(function(j){return{ok:x.ok,j:j}},function(){return{ok:x.ok,j:null}})};
  var apiErr=function(j,fb){if(!j)return fb;var m=j.message||j.detail||j.error;if(!m){for(var k in j){if(Array.isArray(j[k])&&j[k].length){m=j[k][0];break}}}return m?String(m):fb};
  var loadList=function(){sld(!0);return fetch("/api/leave").then(readJson).then(function(r){if(!r.ok||!Array.isArray(r.j))throw 0;sL(r.j);ser("");sld(!1)}).catch(function(){ser("Couldn't load leave requests.");sld(!1)})};
  var loadBal=function(){var e=sess().email||"";if(!e){sbal([]);return}fetch("/api/leave/balance?email="+encodeURIComponent(e)).then(readJson).then(function(r){sbal(r.ok&&r.j&&Array.isArray(r.j.balances)?r.j.balances:[])}).catch(function(){sbal([])})};
  /* Signed-in-user scoped, so it no-ops when logged out. Dropping ?email=
     returns EVERY employee's requests, which the API only serves to a caller
     holding attendance.view (a super admin bypasses it) — with ?email= the
     or_self rule lets a normal employee read their own. `all` is passed in
     rather than read off `appr`, because the permission callback fires before
     that state has been committed. */
  var loadCor=function(all){var e=sess().email||"";if(!e){scor([]);return}fetch(all?"/api/attendance/corrections":"/api/attendance/corrections?email="+encodeURIComponent(e)).then(readJson).then(function(r){scor(r.ok&&Array.isArray(r.j)?r.j:[])}).catch(function(){scor([])})};
  /* Same approver test hrms-attendance-actions.js uses. Fails closed: any
     error, or no session, leaves the review queue hidden. */
  var loadAppr=function(){var e=sess().email||"";if(!e){sIsAp(!1);return}fetch("/api/me/permissions?email="+encodeURIComponent(e)).then(readJson).then(function(r){var d=r.ok&&r.j?r.j:null,ok=!!(d&&(d.superAdmin===!0||(Array.isArray(d.permissions)&&d.permissions.indexOf("settings.manage")!==-1)));sIsAp(ok);if(ok)loadCor(!0)}).catch(function(){sIsAp(!1)})};
  g.useEffect(function(){loadList();loadBal();loadCor(!1);loadAppr()},[]);
  
  /* ---- date helpers ---- */
  var pad=function(v){return String(v).length>1?String(v):"0"+v};
  var iso=function(d){return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())};
  var dObj=function(s){return new Date(s+"T00:00:00")};
  var TODAY=iso(new Date);
  var shift=function(s,k){var d=dObj(s);d.setDate(d.getDate()+k);return iso(d)};
  var WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var wdOf=function(s){var d=dObj(s);return isNaN(d.getTime())?"":WD[d.getDay()]};
  var prettyD=function(s){var d=dObj(s);return isNaN(d.getTime())?s||"—":d.getDate()+" "+MN[d.getMonth()]+" "+d.getFullYear()};
  var dmy=function(s){var d=dObj(s);return isNaN(d.getTime())?s||"—":pad(d.getDate())+"-"+pad(d.getMonth()+1)+"-"+d.getFullYear()};
  var initials=function(s){var p=(s||"?").trim().split(/\s+/).map(function(w){return w.charAt(0)}).join("");return(p||"?").toUpperCase().slice(0,2)};
  var WDL=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var isWknd=function(s){var d=dObj(s).getDay();return d===0||d===6};
  /* "5–7 Aug" / "31 Jul – 2 Aug" / "5 Aug" — compact range for the Who's Out list. */
  var shortR=function(a,b){var x=dObj(a),y=dObj(b);if(isNaN(x.getTime())||isNaN(y.getTime()))return"";
    if(a===b)return x.getDate()+" "+MN[x.getMonth()];
    if(x.getMonth()===y.getMonth()&&x.getFullYear()===y.getFullYear())return x.getDate()+"–"+y.getDate()+" "+MN[x.getMonth()];
    return x.getDate()+" "+MN[x.getMonth()]+" – "+y.getDate()+" "+MN[y.getMonth()]};

  /* ---- holidays ----
     There is no /api/holidays endpoint yet (api/urls.py only exposes leave,
     leave/balance and leave/<id>), so the calendar lives here. Keep the
     {date,name,type} shape and swap this constant for a fetch when HR
     publishes one. Only fixed-date holidays are listed: festival dates move
     every year, so take those from HR's official calendar rather than
     guessing them. Weekends are derived from the date, never listed here. */
  var HOLIDAYS=[
        {date:"2026-01-01",name:"New Year's Day",type:"Company holiday"},
        {date:"2026-01-26",name:"Republic Day",type:"National holiday"},
        {date:"2026-05-01",name:"Labour Day",type:"National holiday"},
        {date:"2026-08-15",name:"Independence Day",type:"National holiday"},
        {date:"2026-10-02",name:"Gandhi Jayanti",type:"National holiday"},
        {date:"2026-12-25",name:"Christmas Day",type:"National holiday"}];
  var HMAP={};HOLIDAYS.forEach(function(h){HMAP[h.date]=h});
  window.__hrmsHolidays=HOLIDAYS;
  /* Only holiday and weekend cells are hoverable, so the "(Weekend)" tail is
     always correct for anything that can actually reach this. The c.w guard
     keeps it that way if a future change ever makes plain days hoverable. */
  var holWhy=function(c){return c.h?prettyD(c.d)+" — "+c.h.name+" ("+c.h.type+")":prettyD(c.d)+" — "+WDL[dObj(c.d).getDay()]+(c.w?" (Weekend)":"")};

  /* ---- leave types + colour map ---- */
  var TYPES=["Casual Leave","Sick Leave","Earned Leave"];
  var TMETA={"Casual Leave":{b:"blue",v:"var(--accent)"},"Sick Leave":{b:"orange",v:"var(--accent4)"},"Earned Leave":{b:"purple",v:"var(--accent2)"}};
  var tmeta=function(t){return TMETA[t]||{b:"blue",v:"var(--accent)"}};
  
  /* ---- form state, validation, submit, approve/decline ---- */
  var setF=function(k,v){sfe("");sf(function(p){var o={...p};o[k]=v;return o})};
  var dayCount=function(a,b){if(!a||!b||b<a)return 0;var x=dObj(a),y=dObj(b);if(isNaN(x.getTime())||isNaN(y.getTime()))return 0;return Math.round((y-x)/864e5)+1};
  var vErr=function(){if(!fm.fromDate||!fm.toDate)return"Select both a from and a to date.";if(fm.toDate<fm.fromDate)return"To date cannot be earlier than from date.";return""};
  var submit=function(){var v=vErr();if(v){sfe(v);return}sb(!0);sfe("");var s=sess();var bd={email:s.email||"",employee:s.name||s.email||"",type:fm.type,fromDate:fm.fromDate,toDate:fm.toDate,reason:fm.reason};fetch("/api/leave",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(bd)}).then(readJson).then(function(r){if(!r.ok||!r.j||!r.j.id){sb(!1);sfe(apiErr(r.j,"Couldn't submit the request. Please try again."));return}sL(function(p){return[r.j].concat(p)});sb(!1);so(!1);sfe("");swr("");sf({type:"Casual Leave",fromDate:"",toDate:"",reason:""});loadBal()}).catch(function(){sb(!1);sfe("Couldn't reach the server. Please try again.")})};
  var setSt=function(id,st){var s=sess(),row=null;for(var i=0;i<L.length;i++){if(L[i].id===id){row=L[i];break}}var prev=row?row.status:"Pending";var revert=function(){sL(function(p){return p.map(function(z){return z.id===id?{...z,status:prev}:z})})};swr("");sL(function(p){return p.map(function(z){return z.id===id?{...z,status:st}:z})});fetch("/api/leave/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:st,approver:s.name||s.email||""})}).then(readJson).then(function(r){if(!r.ok){revert();swr(apiErr(r.j,"Couldn't update that request — the change was rolled back."));return}if(r.j&&r.j.id)sL(function(p){return p.map(function(z){return z.id===id?r.j:z})});loadBal()}).catch(function(){revert();swr("Couldn't reach the server — the change was rolled back.")})};

  /* ---- missed clock-out: helpers, validation, submit ----
     The employee states the date, the time they actually left and why, and a
     super admin approves it. Nothing here reads attendance records — the form
     is filed by hand, so there is no scanning and no prompting. There is also
     no auto-correct: clamping an open day to shift end would silently erase
     overtime, so approval writes the stated time and recomputes worked and
     overtime minutes server-side, which is why the request carries
     requestedCheckOut. requestedCheckIn is never sent, so approval leaves the
     genuine clock-in untouched. */
  var hm=function(s){return String(s||"").slice(11,16)};
  var pt=function(t){if(!t||t.length<5)return"";var h=parseInt(t.slice(0,2),10),m=t.slice(3,5);if(isNaN(h))return"";var ap=h>=12?"PM":"AM",hh=h%12;return pad(hh===0?12:hh)+":"+m+" "+ap};
  var hrm=function(m){return Math.floor(m/60)+"h "+pad(m%60)+"m"};
  /* Returns the SAME object when nothing changed, so React bails out instead of
     re-rendering the page. <input type="date"> reports "" until all three
     segments are valid, so typing a 4-digit year fires several identical
     changes — without this guard each one re-rendered everything and the
     centred modal visibly jumped. */
  var setMF=function(k,v){smfe("");smf(function(p){if(p[k]===v)return p;var o={...p};o[k]=v;return o})};
  /* ONE day, looked up only once a date is chosen — this fills the stamp row
     and the hour tiles. It is deliberately not a scan of every day: an earlier
     version swept the whole record set to warn about forgotten punches, and
     that nagging was removed on purpose. `alive` drops a stale response when
     the date is changed again mid-flight. */
  g.useEffect(function(){
        var d=mfm.date;
        if(!d){smAtt(null);smLd(!1);return}
        var e=sess().email||"";
        if(!e){smAtt(null);smLd(!1);return}
        var alive=!0;smLd(!0);
        /* Debounced: the date field emits a change per segment, so firing
           immediately meant a request (and a loading flip) for every digit. */
        var t=setTimeout(function(){
              fetch("/api/attendance?email="+encodeURIComponent(e)+"&date="+encodeURIComponent(d)).then(readJson).then(function(r){if(!alive)return;smAtt(r.ok&&Array.isArray(r.j)&&r.j.length?r.j[0]:null);smLd(!1)}).catch(function(){if(!alive)return;smAtt(null);smLd(!1)})
            },300);
        return function(){alive=!1;clearTimeout(t)}
      },[mfm.date]);
  var openM=function(){smfe("");smf({date:"",time:"",reason:""});smo(!0)};
  var mErr=function(){
        if(!mfm.date)return"Pick the date you missed clocking out.";
        if(mfm.date>TODAY)return"That date is in the future.";
        if(!mfm.time)return"Enter the time you actually left.";
        if(!(mfm.reason||"").trim())return"Add a short reason for your admin.";
        return""};
  /* Approve / reject, optimistic with rollback — the same shape as setSt on the
     leave table. Uses the perm-gated PUT, never /api/attendance/correction/
     approve/, which is AllowAny and would let anyone approve their own
     overtime. Approving is what actually writes the clock-out onto the
     attendance record and recomputes worked/overtime minutes server-side, and
     the employee is notified there too — nothing to send from here. */
  var setCSt=function(id,st,note){var row=null;for(var i=0;i<cor.length;i++){if(cor[i].id===id){row=cor[i];break}}var prev=row?row.status:"Pending";var revert=function(){scor(function(p){return p.map(function(z){return z.id===id?{...z,status:prev}:z})})};var s=sess();swr("");scor(function(p){return p.map(function(z){return z.id===id?{...z,status:st}:z})});fetch("/api/attendance/corrections/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:st,reviewer:s.name||s.email||"",reviewerNote:note||""})}).then(readJson).then(function(r){if(!r.ok){revert();swr(apiErr(r.j,"Couldn't update that request — the change was rolled back."));return}if(r.j&&r.j.id)scor(function(p){return p.map(function(z){return z.id===id?r.j:z})})}).catch(function(){revert();swr("Couldn't reach the server — the change was rolled back.")})};
  var msubmit=function(){var v=mErr();if(v){smfe(v);return}smb(!0);smfe("");var s=sess();var bd={email:s.email||"",employee:s.name||s.email||"",attendanceDate:mfm.date,requestedCheckOut:mfm.date+" "+mfm.time+":00",reason:mfm.reason};fetch("/api/attendance/corrections",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(bd)}).then(readJson).then(function(r){if(!r.ok||!r.j||!r.j.id){smb(!1);smfe(apiErr(r.j,"Couldn't submit the request. Please try again."));return}scor(function(p){return[r.j].concat(p)});smb(!1);smo(!1);smfe("");smf({date:"",time:"",reason:""});scop(!0)}).catch(function(){smb(!1);smfe("Couldn't reach the server. Please try again.")})};

  /* ---- derived data: counts, absences, period windows ---- */
  var byStatus=function(s){return L.filter(function(z){return z.status===s})};
  var dsum=function(a){return a.reduce(function(t,z){return t+(z.days||0)},0)};
  var pend=byStatus("Pending"),appr=byStatus("Approved"),rej=byStatus("Rejected");
  var people=[];
  L.forEach(function(z){var k=(z.email||z.employee||"").toLowerCase();if(k&&people.indexOf(k)===-1)people.push(k)});
  var onDay=function(z,d){return z.status==="Approved"&&z.fromDate<=d&&z.toDate>=d};
  var outToday=L.filter(function(z){return onDay(z,TODAY)});
  /* Who's Out periods — forward-looking windows from today, inclusive. An
     absence counts if it OVERLAPS the window (fromDate<=end && toDate>=today),
     so someone already part-way through their leave still appears; matching on
     fromDate alone would silently drop them. Lists are built once here so the
     count on each chip and the rows rendered below come from the same array
     and cannot disagree. */
  var PERIODS=[{k:"today",lbl:"Today",d:0,ph:"today"},{k:"1w",lbl:"Week",d:6,ph:"in the next 7 days"},{k:"30d",lbl:"30 days",d:29,ph:"in the next 30 days"},{k:"3m",lbl:"3 months",d:89,ph:"in the next 3 months"},{k:"6m",lbl:"6 months",d:179,ph:"in the next 6 months"}];
  var outIn=function(days){var end=shift(TODAY,days);return L.filter(function(z){return z.status==="Approved"&&z.fromDate<=end&&z.toDate>=TODAY}).slice().sort(function(a,b){return a.fromDate===b.fromDate?(a.id||0)-(b.id||0):a.fromDate<b.fromDate?-1:1})};
  /* Memoised: five filtered+sorted passes over L. Without this every keystroke
     anywhere on the page — including inside a modal — rebuilt all of them. */
  var perLists=g.useMemo(function(){var o={};PERIODS.forEach(function(p){o[p.k]=outIn(p.d)});return o},[L,TODAY]);
  var curP=PERIODS[0];for(var pi=0;pi<PERIODS.length;pi++){if(PERIODS[pi].k===per){curP=PERIODS[pi];break}}
  var curList=perLists[curP.k];
  /* Leave-type split for the selected period, ordered by the same rule as the
     Requests by Type card (most requests first). */
  var curTypes=[];
  curList.forEach(function(z){var t=z.type||"Other",f=null;for(var i=0;i<curTypes.length;i++){if(curTypes[i].type===t){f=curTypes[i];break}}if(!f){f={type:t,n:0};curTypes.push(f)}f.n++});
  curTypes.sort(function(a,b){return b.n-a.n});
  var totRem=bal.reduce(function(a,b){return a+(b.remaining||0)},0),totAll=bal.reduce(function(a,b){return a+(b.allowance||0)},0);
  var qq=q.trim().toLowerCase();
  var rows=g.useMemo(function(){return L.filter(function(z){if(flt!=="All"&&z.status!==flt)return!1;if(!qq)return!0;return((z.employee||"")+" "+(z.email||"")+" "+(z.type||"")).toLowerCase().indexOf(qq)!==-1}).slice().sort(function(a,b){if(srt==="longest")return(b.days||0)-(a.days||0);var x=a.fromDate||"",y=b.fromDate||"";if(x===y)return(b.id||0)-(a.id||0);if(srt==="oldest")return x<y?-1:1;return x<y?1:-1})},[L,flt,qq,srt]);
  var balColor=function(b){var r=b.allowance?b.remaining/b.allowance:0;return r>=.5?"var(--success)":r>=.25?"var(--warn)":"var(--danger)"};
  var types=g.useMemo(function(){var a=[];L.forEach(function(z){var t=z.type||"Other",f=null;for(var i=0;i<a.length;i++){if(a[i].type===t){f=a[i];break}}if(!f){f={type:t,n:0,days:0};a.push(f)}f.n++;f.days+=z.days||0});a.sort(function(x,y){return y.n-x.n});return a},[L]);
  var maxT=types.reduce(function(m,t){return Math.max(m,t.n)},0)||1;

  /* ---- 45-day holiday calendar, weekday-aligned ---- */
  var HOL_DAYS=45;
  /* 45 cells rebuilt on every render before this was memoised — the single
     biggest cost of a keystroke anywhere on the page. */
  var cal=g.useMemo(function(){var a=[];for(var hi=0;hi<HOL_DAYS;hi++){var hdt=shift(TODAY,hi),hh=HMAP[hdt]||null;a.push({d:hdt,h:hh,w:!hh&&isWknd(hdt)})}return a},[TODAY]);
  var calLead=g.useMemo(function(){return dObj(TODAY).getDay()},[TODAY]);
  var calSpan=g.useMemo(function(){var a=dObj(cal[0].d),b=dObj(cal[cal.length-1].d);var s=MN[a.getMonth()];return a.getMonth()===b.getMonth()?s+" "+b.getFullYear():s+" – "+MN[b.getMonth()]+" "+b.getFullYear()},[cal]);

  /* ---- small render helpers ---- */
  /* Section labels and helper text inside Who's Out / Holidays. This has been
     walked up twice: --text3 washed out completely against the card, and
     --text2 still read too faint next to the "N requests · Nd" values in
     Requests by Type, which are plain --text. Matching those is the bar, so
     this is --text. One constant, not per-node overrides, so it stays a
     single knob — the labels are held below the headings by size and weight,
     not by colour. */
  var LBL="var(--text)";
  /* Who is out, by name — the old avRow showed bare initials circles, so you
     could count absences but not tell who they were. Caps at 3 with a
     "+N more" toggle so a busy week can't stretch the card open. */
  var CAP=6,LIST_MAX=240;
  var pplList=function(list,key,empty){
        if(!list.length)return n.jsx("div",{style:{fontSize:12,color:LBL,marginTop:10},children:empty});
        var open=!!more[key],show=open?list:list.slice(0,CAP),rest=list.length-show.length;
        var grid=n.jsx("div",{style:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:10},children:show.map(function(z,i){var tm=tmeta(z.type);return n.jsxs("div",{title:(z.employee||z.email)+" · "+z.type+" · "+prettyD(z.fromDate)+" → "+prettyD(z.toDate),style:{display:"flex",alignItems:"center",gap:8,minWidth:0},children:[
                          n.jsx(Et,{initials:initials(z.employee||z.email),size:24,gradient:"135deg, "+tm.v+", var(--accent2)"}),
                          n.jsxs("div",{style:{minWidth:0},children:[
                                n.jsx("div",{style:{fontSize:12,fontWeight:600,color:"var(--text)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"},children:z.employee||z.email}),
                                n.jsxs("div",{style:{display:"flex",alignItems:"center",gap:5,marginTop:2,minWidth:0},children:[
                                      n.jsx("span",{className:"badge "+tm.b,style:{fontSize:10,padding:"1px 5px",flex:"0 0 auto"},children:(z.type||"Leave").replace(" Leave","")}),
                                      n.jsx("span",{style:{fontSize:11,color:LBL,whiteSpace:"nowrap"},children:shortR(z.fromDate,z.toDate)})]})]})]},z.id||i)})});
        /* Expanded, the list scrolls inside a fixed box rather than growing the
           card — otherwise a busy month stretches Who's Out and, because the
           row is align-items:stretch, drags the Calendar card down with it. */
        return n.jsxs("div",{style:{marginTop:10},children:[open?
              n.jsx("div",{tabIndex:0,role:"region","aria-label":"People on leave — scrollable list",style:{maxHeight:LIST_MAX,overflowY:"auto",paddingRight:8,scrollbarWidth:"thin",scrollbarColor:"var(--border2) transparent"},children:grid}):grid,rest>0||open?
              n.jsx("button",{onClick:function(){smore(function(p){var o={...p};o[key]=!open;return o})},style:{background:"none",border:"none",padding:0,marginTop:10,fontFamily:"inherit",fontSize:11.5,fontWeight:600,color:"var(--accent)",cursor:"pointer"},children:open?"Show less":"+"+rest+" more"}):null]})};
  /* One calendar cell + its own tooltip. The tooltip is anchored off the
     column index (left edge / centred / right edge) instead of measuring, so
     it can never run off the side of the card. */
  var holCell=function(c,col){
        var act=!!(c.h||c.w),on=hd===c.d;
        var al=col<=1?{left:0}:col>=5?{right:0}:{left:"50%",transform:"translateX(-50%)"};
        return n.jsxs("div",{style:{position:"relative"},children:[
              n.jsx("div",{tabIndex:act?0:undefined,"aria-label":act?holWhy(c):undefined,
                  onMouseEnter:act?function(){shd(c.d)}:undefined,onMouseLeave:act?function(){shd(null)}:undefined,
                  onFocus:act?function(){shd(c.d)}:undefined,onBlur:act?function(){shd(null)}:undefined,
                  style:{height:26,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:6,fontSize:11.5,fontWeight:act?700:600,background:c.h?"var(--cal-holiday-bg)":c.w?"var(--cal-weekend-bg)":"var(--bg3)",color:c.h?"var(--cal-holiday-fg)":c.w?"var(--cal-weekend-fg)":LBL,cursor:act?"help":"default",outline:c.d===TODAY?"2px solid var(--accent2)":"none",outlineOffset:1,boxShadow:on?"0 0 0 2px var(--accent)":"none",transition:"box-shadow .15s"},
                  children:dObj(c.d).getDate()}),on?
              n.jsx("div",{role:"tooltip",style:{position:"absolute",bottom:"calc(100% + 6px)",zIndex:30,width:180,background:"var(--surface)",border:"1px solid var(--border2)",borderRadius:7,padding:"6px 9px",fontSize:11.5,lineHeight:1.45,color:"var(--text)",boxShadow:"0 8px 20px rgba(0,0,0,.3)",pointerEvents:"none",...al},children:holWhy(c)}):null]},c.d)};
  var legend=function(col,txt){return n.jsxs("span",{style:{display:"inline-flex",alignItems:"center",gap:5},children:[
              n.jsx("span",{style:{width:8,height:8,borderRadius:2,background:col,display:"inline-block"}}),txt]},txt)};
  var kv=function(k,v){return n.jsxs("div",{children:[
              n.jsx("div",{style:{fontSize:11,fontWeight:600,letterSpacing:.5,textTransform:"uppercase",color:"var(--text2)",marginBottom:3},children:k}),
              n.jsx("div",{style:{fontSize:12,color:"var(--text2)",lineHeight:1.5,wordBreak:"break-word"},children:v})]},k)};
  /* Stat-card value = icon + number. The bundle's B passes `value` straight
     through as the children of .stat-value, so a card can hand it an element
     instead of a string — no need to touch index-DCh6bk0Rv4.js.
     Colour rides on `color` + stroke="currentColor" (the same pattern the
     topbar and sidebar icons use); a var() in a bare stroke="" attribute is
     not substituted by every browser, so it has to go through the style. */
  /* All four share the clock's r=9 ring so they read as one set. The inner
     glyphs are drawn small enough to sit inside it — a ring at r=9 only
     comfortably holds about x/y 6..18, so the full-viewBox versions of these
     paths would have spilled straight through it.
     The tick is the deliberate exception: its long arm ends at (20,6), ~10
     units from the centre, so it breaks back out through the ring. */
  var SICON={
        clock:{c:[[12,12,9]],p:["M12 7v5l3 2"]},
        check:{c:[[12,12,9]],p:["M8 12.5L11 15.5L20 6"]},
        list:{c:[[12,12,9]],p:["M10 9h6M10 12h6M10 15h6"]},
        cross:{c:[[12,12,9]],p:["M15 9l-6 6M9 9l6 6"]}};
  var statVal=function(kind,col,txt){var ic=SICON[kind];
        return n.jsxs("span",{style:{display:"inline-flex",alignItems:"center",gap:8},children:[
              n.jsxs("svg",{viewBox:"0 0 24 24",width:20,height:20,fill:"none",stroke:"currentColor",strokeWidth:1.8,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":"true",focusable:"false",style:{color:col,flex:"0 0 auto"},children:[
                    (ic.c||[]).map(function(v,i){return n.jsx("circle",{cx:v[0],cy:v[1],r:v[2]},"c"+i)}),
                    ic.p.map(function(d,i){return n.jsx("path",{d:d},"p"+i)})]}),
              /* .stat-value is Syne 800 for the whole app; these four cards want
                 it lighter and tighter. Set it on the number itself rather than
                 on .stat-value, which B renders on every dashboard. 700 is a
                 real Syne cut (index.html loads 400;500;600;700;800), so this
                 is not a synthesised weight. */
              n.jsx("span",{style:{fontWeight:700,letterSpacing:"-.02em"},children:txt})]})};
  var msgSt={fontSize:12,color:"var(--text3)",padding:"26px 0",textAlign:"center"};
  
  /* ---- table body: loading / error / empty / no-match / rows ---- */
  var body=[];
  if(ld)body.push(
        n.jsx("tr",{children:
            n.jsx("td",{colSpan:7,style:msgSt,children:"Loading leave requests…"})},"ld"));
  else if(er)body.push(
        n.jsx("tr",{children:
            n.jsxs("td",{colSpan:7,style:msgSt,children:[
                  n.jsx("div",{style:{marginBottom:9,color:"var(--danger)"},children:er}),
                  n.jsx("button",{className:"btn-sm",onClick:function(){loadList();loadBal()},children:"Retry"})]})},"er"));
  else if(!L.length)body.push(
        n.jsx("tr",{children:
            n.jsxs("td",{colSpan:7,style:msgSt,children:[
                  n.jsx("div",{style:{fontSize:26,marginBottom:6},children:"🗓"}),
                  n.jsx("div",{style:{fontWeight:600,color:"var(--text2)",marginBottom:4},children:"No leave requests yet."}),
                  n.jsx("div",{children:"Use + Apply Leave to submit the first one."})]})},"empty"));
  else if(!rows.length)body.push(
        n.jsx("tr",{children:
            n.jsxs("td",{colSpan:7,style:msgSt,children:[
                  n.jsx("div",{style:{marginBottom:9},children:"No requests match this filter."}),
                  n.jsx("button",{className:"btn-sm",onClick:function(){sflt("All");sq("")},children:"Clear filters"})]})},"nomatch"));
  else rows.forEach(function(e){var tm=tmeta(e.type);var live=onDay(e,TODAY);body.push(
            n.jsxs("tr",{onClick:function(){sexp(exp===e.id?null:e.id)},style:{cursor:"pointer"},title:"Show reason, approver and applied date",children:[
                  n.jsx("td",{children:
                      n.jsxs("div",{style:{display:"flex",alignItems:"center",gap:9},children:[
                            n.jsx("span",{style:{color:"var(--text3)",fontSize:10,width:9,display:"inline-block"},children:exp===e.id?"▼":"▶"}),
                            n.jsx(Et,{initials:initials(e.employee||e.email),size:28,gradient:"135deg, "+tm.v+", var(--accent2)"}),
                            n.jsxs("div",{style:{minWidth:0},children:[
                                  n.jsxs("div",{style:{fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:6},children:[e.employee||e.email,live?
                                        n.jsx("span",{className:"badge green",style:{fontSize:10,padding:"1px 6px"},children:"Out now"}):null]}),
                                  n.jsx("div",{style:{fontSize:11,color:"var(--text3)",overflow:"hidden",textOverflow:"ellipsis"},children:e.email||""})]})]})}),
                  n.jsx("td",{children:
                      n.jsx("span",{className:"badge "+tm.b,children:e.type})}),
                  n.jsxs("td",{style:{fontSize:12},children:[dmy(e.fromDate),
                        n.jsx("div",{style:{fontSize:11,color:"var(--text3)"},children:wdOf(e.fromDate)})]}),
                  n.jsxs("td",{style:{fontSize:12},children:[dmy(e.toDate),
                        n.jsx("div",{style:{fontSize:11,color:"var(--text3)"},children:wdOf(e.toDate)})]}),
                  n.jsx("td",{children:
                      n.jsxs("span",{style:{display:"inline-flex",alignItems:"baseline",gap:3,background:"var(--bg3)",border:"1px solid var(--border2)",borderRadius:6,padding:"2px 8px"},children:[
                            n.jsx("span",{style:{fontSize:13,fontWeight:700,fontFamily:"var(--font-d)"},children:e.days}),
                            n.jsx("span",{style:{fontSize:11,color:"var(--text3)"},children:(e.days||0)===1?"day":"days"})]})}),
                  n.jsx("td",{children:
                      n.jsx(Gn,{status:e.status})}),
                  n.jsx("td",{children:e.status==="Pending"?
                      n.jsxs("div",{style:{display:"flex",gap:6},children:[
                            n.jsx("button",{className:"btn-sm","data-perm":"leave.approve",style:{fontSize:11,padding:"2px 8px",color:"var(--success)"},onClick:function(ev){ev.stopPropagation();setSt(e.id,"Approved")},children:"Approve"}),
                            n.jsx("button",{className:"btn-sm","data-perm":"leave.reject",style:{fontSize:11,padding:"2px 8px",color:"var(--danger)"},onClick:function(ev){ev.stopPropagation();scf(e)},children:"Decline"})]}):
                      n.jsx("span",{style:{fontSize:12,color:"var(--text3)"},children:"—"})})]},e.id));if(exp===e.id){var dot=function(on,col){return n.jsx("span",{style:{width:9,height:9,borderRadius:"50%",background:on?col:"var(--border2)",display:"inline-block",flex:"0 0 auto"}})};var decided=e.status==="Approved"||e.status==="Rejected";body.push(
              n.jsx("tr",{children:
                  n.jsx("td",{colSpan:7,style:{background:"var(--bg3)",padding:"14px 16px",borderLeft:"3px solid "+tm.v},children:
                      n.jsxs("div",{style:{color:"var(--text)"},children:[
                            n.jsxs("div",{style:{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"},children:[dot(!0,"var(--accent)"),
                                  n.jsxs("span",{style:{fontSize:12,color:"var(--text2)"},children:["Applied ",
                                        n.jsx("strong",{children:e.createdAt||"—"})]}),
                                  n.jsx("span",{style:{flex:"0 0 26px",height:1,background:"var(--border2)"}}),dot(decided,e.status==="Approved"?"var(--success)":"var(--danger)"),
                                  n.jsx("span",{style:{fontSize:12,color:"var(--text2)"},children:decided?e.status+(e.approver?" by "+e.approver:""):"Awaiting a decision"})]}),
                            n.jsxs("div",{style:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:14},children:[kv("Reason",e.reason||"— none given —"),kv("Approver",e.approver||"— not actioned yet —"),kv("Applied on",e.createdAt||"—"),kv("Duration",(e.days||0)+((e.days||0)===1?" day":" days")+" · "+prettyD(e.fromDate)+" → "+prettyD(e.toDate))]})]})})},e.id+"-d"))}});
  var selBal=null;
  for(var bi=0;bi<bal.length;bi++){if(bal[bi].type===fm.type){selBal=bal[bi];break}}var dc=dayCount(fm.fromDate,fm.toDate),liveErr=fm.fromDate&&fm.toDate?vErr():"";
  /* Stamp row + hour tiles. Gross is the span between the recorded clock-in and
     the time being claimed; effective takes the day's logged breaks off it.
     Both stay "—" until there is a real clock-in AND an entered time, so the
     tiles never show a number derived from half the data. */
  var mIn=mAtt&&mAtt.checkIn?hm(mAtt.checkIn):"";
  var mMin=(function(){if(!mIn||!mfm.time)return 0;var a=parseInt(mIn.slice(0,2),10)*60+parseInt(mIn.slice(3,5),10),b=parseInt(mfm.time.slice(0,2),10)*60+parseInt(mfm.time.slice(3,5),10);if(isNaN(a)||isNaN(b)||b<=a)return 0;return b-a})();
  var mEff=Math.max(0,mMin-((mAtt&&mAtt.breakMinutes)||0));
  var mSrc=!mAtt?"Clock In":mAtt.isWfh?"Remote Clock In":"Office Clock In";
  var mOut=mAtt&&mAtt.checkOut?hm(mAtt.checkOut):"";
  /* Status defaults to Pending when absent so a row can never fall out of every
     filter bucket and vanish from the queue. */
  var cst=function(z){return z.status||"Pending"};
  var CFLT=["All","Pending","Approved","Rejected"];
  var cCount=function(s){return s==="All"?cor.length:cor.filter(function(z){return cst(z)===s}).length};
  var cPend=cCount("Pending");
  var cRows=isAp&&cflt!=="All"?cor.filter(function(z){return cst(z)===cflt}):cor;
  var cCols=isAp?["Employee","Date","Requested clock-out","Reason","Status","Reviewer","Action"]:["Employee","Date","Requested clock-out","Reason","Status","Reviewer"];
  var cGrid={display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10};
  /* Timeline dot for the detail panel. The leave table has an identical helper,
     but it is declared inside its row-building loop and is not in scope here. */
  var cdot=function(on,col){return n.jsx("span",{style:{width:9,height:9,borderRadius:"50%",background:on?col:"var(--border2)",display:"inline-block",flex:"0 0 auto"}})};
  var cmeta=function(s){return s==="Approved"?{b:"green",v:"var(--success)"}:s==="Rejected"?{b:"red",v:"var(--danger)"}:{b:"orange",v:"var(--warn)"}};

  /* ---- render ---- */
  return n.jsxs("div",{children:[
            n.jsxs("div",{className:"stat-grid",children:[
                  n.jsx(B,{label:"Pending Requests",value:statVal("clock","var(--accent)",String(pend.length)),sub:dsum(pend)+" days awaiting",color:"blue"}),
                  n.jsx(B,{label:"Approved",value:statVal("check","var(--success)",String(appr.length)),sub:dsum(appr)+" days granted",color:"green"}),
                  n.jsx(B,{label:"Total Requests",value:statVal("list","var(--accent4)",String(L.length)),sub:people.length+(people.length===1?" employee":" employees"),color:"orange"}),
                  n.jsx(B,{label:"Rejected",value:statVal("cross","var(--accent2)",String(rej.length)),sub:L.length?Math.round(rej.length/L.length*100)+"% of all requests":"—",color:"purple"})]}),
            n.jsxs("div",{style:{display:"flex",justifyContent:"flex-end",gap:8,marginTop:-6,marginBottom:16},children:[
                /* No data-perm, exactly like "+ Apply Leave" next to it: this is a
                   self-service action the API gates with or_self=true, so every
                   signed-in user may file one for their OWN day. Tagging it with a
                   module permission (attendance.create) hid it from everyone whose
                   role lacks that code — which is most employees. */
                n.jsx("button",{className:"btn-sm",onClick:function(){openM()},children:"+ Missed Clock-Out"}),
                n.jsx("button",{className:"btn-primary",onClick:function(){sfe("");so(!0)},children:"+ Apply Leave"})]}),
            n.jsxs("div",{style:{display:"flex",gap:14,flexWrap:"wrap",marginBottom:16,alignItems:"stretch"},children:[
                  n.jsxs("div",{className:"card",style:{flex:"3 1 520px",minWidth:0,background:"linear-gradient(135deg, var(--bg2) 0%, var(--bg3) 100%)"},children:[
                        n.jsxs("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",marginBottom:4},children:[
                              n.jsx("div",{className:"card-title",style:{marginBottom:0,color:LBL},children:"Who's Out"}),
                              n.jsxs("div",{style:{fontSize:12,color:LBL,marginLeft:"auto"},children:["Today is ",prettyD(TODAY)]})]}),
                        n.jsx("div",{style:{fontSize:12.5,fontWeight:600,color:outToday.length?"var(--success)":LBL,marginTop:7},children:outToday.length?outToday.length+(outToday.length===1?" person is":" people are")+" on leave today":"Everyone is in today."}),
                        n.jsx("div",{style:{display:"flex",gap:8,flexWrap:"wrap",marginTop:13},role:"group","aria-label":"Absence period",children:PERIODS.map(function(p){var on=per===p.k;return n.jsxs("button",{className:"chip"+(on?" active":""),"aria-pressed":on,onClick:function(){sper(p.k);smore({})},style:{fontFamily:"inherit"},children:[p.lbl," ",
                                    n.jsx("span",{style:{opacity:.7},children:perLists[p.k].length})]},p.k)})}),
                        n.jsxs("div",{style:{display:"flex",alignItems:"baseline",gap:6,marginTop:14},children:[
                              n.jsx("span",{style:{fontFamily:"var(--font-d)",fontSize:26,fontWeight:700,color:"var(--accent)",lineHeight:1},children:curList.length}),
                              n.jsxs("span",{style:{fontSize:12,color:LBL},children:[curList.length===1?"absence":"absences"," ",curP.ph]})]}),curTypes.length?
                        n.jsx("div",{style:{display:"flex",gap:11,flexWrap:"wrap",marginTop:7,fontSize:11.5,color:LBL},children:curTypes.map(function(t){return n.jsxs("span",{style:{display:"inline-flex",alignItems:"center",gap:5},children:[
                                    n.jsx("span",{style:{width:7,height:7,borderRadius:"50%",background:tmeta(t.type).v,display:"inline-block"}}),(t.type||"Leave").replace(" Leave","")," ",
                                    n.jsx("strong",{style:{color:"var(--text)"},children:t.n})]},t.type)})}):null,pplList(curList,curP.k,"Nobody is out "+curP.ph+".")]}),
                  n.jsxs("div",{className:"card",style:{flex:"2 1 360px",minWidth:0},children:[
                        n.jsxs("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",marginBottom:4},children:[
                              n.jsx("div",{className:"card-title",style:{marginBottom:0,color:LBL},children:"Holidays"}),
                              n.jsx("div",{style:{fontSize:12,color:LBL,marginLeft:"auto"},children:calSpan})]}),
                        n.jsx("div",{style:{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4,marginTop:14},children:["S","M","T","W","T","F","S"].map(function(w,i){return n.jsx("div",{style:{fontSize:10,fontWeight:700,letterSpacing:.6,textAlign:"center",color:LBL,paddingBottom:2},children:w},"wd"+i)})}),
                        n.jsxs("div",{style:{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4},children:[Array.from({length:calLead},function(_,i){return n.jsx("div",{},"pad"+i)}),cal.map(function(c,i){return holCell(c,(calLead+i)%7)})]}),
                        n.jsxs("div",{style:{display:"flex",gap:14,fontSize:11,color:LBL,marginTop:10,flexWrap:"wrap"},children:[legend("var(--cal-holiday-dot)","Holiday"),legend("var(--cal-weekend-dot)","Weekend")]})]})]}),
            n.jsxs("div",{className:"grid-2 mb-16",children:[
                  n.jsxs("div",{className:"card",children:[
                        n.jsxs("div",{style:{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10},children:[
                              n.jsx("div",{className:"card-title",children:"My Leave Balance"}),bal.length?
                              n.jsxs("div",{style:{textAlign:"right",lineHeight:1.15},children:[
                                    n.jsx("div",{style:{fontFamily:"var(--font-d)",fontSize:20,fontWeight:700,color:"var(--success)"},children:totRem}),
                                    n.jsxs("div",{style:{fontSize:11,color:"var(--text3)"},children:["of ",totAll," days left"]})]}):null]}),
                        n.jsx("div",{style:{color:"var(--text)"},children:bal.length?bal.map(function(b){return n.jsx(Dr,{label:b.type,value:b.remaining+" of "+b.allowance+" left",pct:Math.min(100,Math.round(b.used/(b.allowance||1)*100)),color:balColor(b)},b.type)}):
                            n.jsx("div",{style:{fontSize:12,color:"var(--text3)",padding:"4px 0"},children:"Sign in to see your leave balance."})}),bal.length?
                        n.jsx("div",{style:{fontSize:12,color:"var(--text3)",marginTop:12},children:"Bars show days already used against your annual allowance."}):null]}),
                  n.jsxs("div",{className:"card",children:[
                        n.jsx("div",{className:"card-title",children:"Requests by Type"}),
                        n.jsx("div",{style:{color:"var(--text)"},children:types.length?types.map(function(t){return n.jsx(Dr,{label:t.type,value:t.n+" request"+(t.n===1?"":"s")+" · "+t.days+"d",pct:Math.round(t.n/maxT*100),color:tmeta(t.type).v},t.type)}):
                            n.jsx("div",{style:{fontSize:12,color:"var(--text3)",padding:"4px 0"},children:"No requests to break down yet."})})]})]}),
            n.jsxs("div",{className:"card",children:[
                  n.jsx(Us,{title:"Leave Requests",subtitle:L.length?rows.length+" of "+L.length+" shown":""}),
                  n.jsxs("div",{style:{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:14},children:[
                        n.jsx("div",{style:{display:"flex",gap:8,flexWrap:"wrap"},children:["All","Pending","Approved","Rejected"].map(function(s){return n.jsxs("div",{className:"chip"+(flt===s?" active":""),onClick:function(){sflt(s)},children:[s," ",
                                      n.jsx("span",{style:{opacity:.7},children:s==="All"?L.length:byStatus(s).length})]},s)})}),
                        n.jsxs("div",{style:{display:"flex",gap:8,marginLeft:"auto",flex:"1 1 260px",justifyContent:"flex-end",flexWrap:"wrap"},children:[
                              n.jsx("div",{style:{flex:"0 0 128px"},children:
                                  n.jsx(cn,{value:srt,onChange:function(e){ssrt(e.target.value)},style:{cursor:"pointer",fontSize:12,padding:"7px 9px"},children:[["newest","Newest first"],["oldest","Oldest first"],["longest","Longest first"]].map(function(o){return n.jsx("option",{value:o[0],children:o[1]},o[0])})})}),
                              n.jsx("div",{style:{flex:"1 1 150px",minWidth:140,maxWidth:250},children:
                                  n.jsx(Qe,{placeholder:"Search employee or type…",value:q,onChange:function(e){sq(e.target.value)}})})]})]}),wr?
                  n.jsxs("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap",background:"var(--bg3)",border:"1px solid var(--danger)",borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:12,color:"var(--danger)"},children:[
                        n.jsx("span",{children:wr}),
                        n.jsx("button",{className:"btn-sm",onClick:function(){swr("")},children:"Dismiss"})]}):null,
                  n.jsx("div",{className:"table-wrap",children:
                      n.jsxs("table",{children:[
                            n.jsx("thead",{children:
                                n.jsx("tr",{children:["Employee","Type","From","To","Days","Status","Action"].map(function(e){return n.jsx("th",{children:e},e)})})}),
                            n.jsx("tbody",{children:body})]})})]}),cor.length?
            /* Deliberately NOT a <table>: hrms-perms.js locates the Leave
               action column by scanning every <table> on this route, so a
               second one here would risk it gating the wrong cells. */
            n.jsxs("div",{className:"card",style:{marginTop:16},children:[
                  n.jsxs("div",{onClick:function(){scop(!cop)},role:"button",tabIndex:0,"aria-expanded":cop,onKeyDown:function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();scop(!cop)}},style:{display:"flex",alignItems:"center",gap:9,cursor:"pointer"},children:[
                        n.jsx("span",{style:{color:"var(--text3)",fontSize:10,width:9,display:"inline-block"},children:cop?"▼":"▶"}),
                        n.jsx("div",{className:"card-title",style:{marginBottom:0},children:isAp?"Missed Clock-Out Requests":"My Missed Clock-Out Requests"}),
                        n.jsx("span",{style:{fontSize:12,color:LBL,marginLeft:"auto"},children:isAp?cPend+" pending of "+cor.length:cor.length+(cor.length===1?" request":" requests")})]}),cop?
                  n.jsxs("div",{style:{marginTop:12},children:[isAp?
                        n.jsx("div",{style:{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12},children:CFLT.map(function(s){return n.jsxs("div",{className:"chip"+(cflt===s?" active":""),onClick:function(){scflt(s)},children:[s," ",
                                    n.jsx("span",{style:{opacity:.7},children:cCount(s)})]},s)})}):null,
                        n.jsx("div",{style:{...cGrid,fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"var(--text2)",paddingBottom:7},children:cCols.map(function(h){return n.jsx("div",{children:h},h)})}),!cRows.length?
                        n.jsx("div",{style:{fontSize:12,color:"var(--text3)",padding:"10px 0"},children:isAp?"No "+cflt.toLowerCase()+" requests.":"Nothing submitted yet."}):null,cRows.map(function(c,i){var cm=cmeta(cst(c)),cop2=cexp===c.id,cdec=cst(c)!=="Pending";
                              /* Wrapper holds the grid row plus, when open, the detail
                                 panel as a SIBLING — a grid child would be squeezed
                                 into one column instead of spanning the row. */
                              return n.jsxs("div",{style:{borderTop:"1px solid var(--border2)"},children:[
                                    n.jsxs("div",{onClick:function(){scexp(cop2?null:c.id)},title:"Show the full reason and the admin's note",style:{...cGrid,fontSize:12,color:"var(--text2)",padding:"9px 0",alignItems:"center",cursor:"pointer"},children:[
                                          n.jsxs("div",{style:{display:"flex",alignItems:"center",gap:9,minWidth:0},children:[
                                                n.jsx("span",{style:{color:"var(--text3)",fontSize:10,width:9,display:"inline-block",flex:"0 0 auto"},children:cop2?"▼":"▶"}),
                                                n.jsx(Et,{initials:initials(c.employee||c.email),size:28,gradient:"135deg, "+cm.v+", var(--accent2)"}),
                                                n.jsxs("div",{style:{minWidth:0},children:[
                                                      n.jsx("div",{style:{fontSize:12,fontWeight:600,color:"var(--text)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"},children:c.employee||c.email||"—"}),
                                                      n.jsx("div",{style:{fontSize:11.5,color:"var(--text3)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"},children:c.email||""})]})]}),
                                          n.jsx("div",{style:{color:"var(--text)",fontWeight:600},children:prettyD(c.attendanceDate)}),
                                          n.jsx("div",{children:c.requestedCheckOut?pt(hm(c.requestedCheckOut)):"—"}),
                                          n.jsx("div",{title:c.reason||"",style:{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"},children:c.reason||"— none given —"}),
                                          n.jsx("div",{children:
                                              n.jsx("span",{className:"badge "+cm.b,style:{fontSize:10,padding:"1px 6px"},children:cst(c)})}),
                                          n.jsx("div",{style:{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"},children:c.reviewer||"— not actioned yet —"}),isAp?
                                          /* stopPropagation, or approving also toggles the panel */
                                          n.jsx("div",{onClick:function(e){e.stopPropagation()},children:cst(c)==="Pending"?
                                              n.jsxs("div",{style:{display:"flex",gap:6,flexWrap:"wrap"},children:[
                                                    n.jsx("button",{className:"btn-sm",onClick:function(){setCSt(c.id,"Approved","")},children:"Approve"}),
                                                    n.jsx("button",{className:"btn-sm",onClick:function(){setCSt(c.id,"Rejected","")},children:"Reject"})]}):"—"}):null]}),cop2?
                                    n.jsxs("div",{style:{background:"var(--bg3)",padding:"14px 16px",borderLeft:"3px solid "+cm.v,color:"var(--text)"},children:[
                                          n.jsxs("div",{style:{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"},children:[cdot(!0,"var(--accent)"),
                                                n.jsxs("span",{style:{fontSize:12,color:"var(--text2)"},children:["Submitted ",
                                                      n.jsx("strong",{children:c.createdAt||"—"})]}),
                                                n.jsx("span",{style:{flex:"0 0 26px",height:1,background:"var(--border2)"}}),cdot(cdec,cm.v),
                                                n.jsx("span",{style:{fontSize:12,color:"var(--text2)"},children:cdec?cst(c)+(c.reviewer?" by "+c.reviewer:""):"Awaiting a decision"})]}),
                                          n.jsxs("div",{style:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:14},children:[kv("Reason",c.reason||"— none given —"),kv("Requested clock-out",c.requestedCheckOut?pt(hm(c.requestedCheckOut)):"—"),kv("Reviewer",c.reviewer||"— not actioned yet —"),kv("Submitted on",c.createdAt||"—")]}),c.reviewerNote?
                                          n.jsxs("div",{style:{marginTop:12,padding:"10px 12px",borderRadius:8,background:"var(--bg2)",borderLeft:"3px solid "+cm.v},children:[
                                                n.jsx("div",{style:{fontSize:11,fontWeight:600,letterSpacing:.5,textTransform:"uppercase",color:"var(--text2)",marginBottom:3},children:cst(c)==="Rejected"?"Reason for rejection":"Admin's note"}),
                                                n.jsx("div",{style:{fontSize:12,color:"var(--text2)",lineHeight:1.5,wordBreak:"break-word"},children:c.reviewerNote})]}):null]}):null]},c.id||i)})]}):null]}):null,
            n.jsxs(Hs,{open:op,onClose:function(){so(!1);sfe("")},title:"Apply Leave",width:480,children:[
                  n.jsx("div",{style:{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"},children:TYPES.map(function(t){var on=fm.type===t,m=tmeta(t),b=null;for(var i=0;i<bal.length;i++){if(bal[i].type===t){b=bal[i];break}}return n.jsxs("div",{onClick:function(){setF("type",t)},style:{flex:"1 1 120px",cursor:"pointer",borderRadius:10,padding:"10px 11px",border:"1px solid "+(on?m.v:"var(--border2)"),background:on?"var(--bg3)":"transparent",transition:"all .15s"},children:[
                                n.jsxs("div",{style:{display:"flex",alignItems:"center",gap:6},children:[
                                      n.jsx("span",{style:{width:8,height:8,borderRadius:"50%",background:m.v,display:"inline-block"}}),
                                      n.jsx("span",{style:{fontSize:12,fontWeight:600,color:on?"var(--text)":"var(--text2)"},children:t.replace(" Leave","")})]}),
                                n.jsx("div",{style:{fontSize:11,color:"var(--text3)",marginTop:4},children:b?b.remaining+" of "+b.allowance+" left":"—"})]},t)})}),
                  n.jsxs(Bt,{children:[
                        n.jsx(le,{label:"From",required:!0,children:
                            n.jsx(Qe,{type:"date",value:fm.fromDate,onChange:function(d){setF("fromDate",d.target.value)}})}),
                        n.jsx(le,{label:"To",required:!0,children:
                            n.jsx(Qe,{type:"date",value:fm.toDate,onChange:function(d){setF("toDate",d.target.value)}})})]}),
                  n.jsx("div",{style:{marginTop:-6,marginBottom:16,fontSize:12,padding:dc||liveErr?"9px 11px":"0",borderRadius:8,background:dc||liveErr?"var(--bg3)":"transparent",color:liveErr?"var(--danger)":dc?"var(--text2)":"var(--text3)"},children:liveErr||(dc?
                        n.jsxs("span",{children:[
                              n.jsxs("strong",{children:[dc," ",dc===1?"day":"days"]})," · ",prettyD(fm.fromDate)," → ",prettyD(fm.toDate),selBal&&dc>selBal.remaining?
                              n.jsxs("span",{style:{color:"var(--danger)"},children:[" — more than your remaining ",selBal.type," balance"]}):null]}):"Pick both dates to see the duration.")}),
                  n.jsx(le,{label:"Reason",children:
                      n.jsx("textarea",{className:"input-field",rows:3,style:{resize:"vertical"},value:fm.reason,onChange:function(d){setF("reason",d.target.value)},placeholder:"Optional — a short note for your approver"})}),fe?
                  n.jsx("div",{style:{fontSize:12,color:"var(--danger)",marginTop:-8},children:fe}):null,
                  n.jsx(Vs,{onCancel:function(){so(!1);sfe("")},onConfirm:submit,confirmLabel:"Apply",loading:bz})]}),
            n.jsxs(Hs,{open:mop,onClose:function(){smo(!1);smfe("")},title:"Missed Clock-Out",width:520,children:[
                  n.jsx("div",{style:{background:"var(--bg3)",border:"1px solid var(--warn)",borderRadius:8,padding:"9px 12px",fontSize:12,color:"var(--warn)",marginBottom:14},children:"You can only adjust a missing clock-out."}),
                  n.jsx("div",{style:{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"},children:[["Gross hours",mMin],["Effective hours",mEff]].map(function(t){return n.jsxs("div",{style:{flex:"1 1 140px",borderRadius:10,padding:"12px 14px",border:"1px solid var(--border2)"},children:[
                                n.jsx("div",{style:{fontFamily:"var(--font-d)",fontSize:20,fontWeight:700,color:"var(--text)",lineHeight:1.1},children:mMin?hrm(t[1]):"—"}),
                                n.jsx("div",{style:{fontSize:12,color:"var(--text3)",marginTop:4},children:t[0]})]},t[0])})}),
                  n.jsxs(Bt,{children:[
                        n.jsx(le,{label:"Date",required:!0,children:
                            n.jsx(Qe,{type:"date",max:TODAY,value:mfm.date,onChange:function(d){setMF("date",d.target.value)}})}),
                        n.jsx(le,{label:"Clock-out time",required:!0,children:
                            n.jsx(Qe,{type:"time",value:mfm.time,onChange:function(d){setMF("time",d.target.value)}})})]}),
                  n.jsx("div",{style:{fontSize:13,fontWeight:600,color:"var(--text)",marginTop:2},children:"Attendance Adjustment"}),
                  n.jsx("div",{style:{fontSize:12,color:"var(--text3)",marginTop:4,marginBottom:10},children:"Your recorded clock-in for this day, and the time you actually left."}),
                  n.jsxs("div",{style:{border:"1px solid var(--border2)",borderRadius:10,overflow:"hidden"},children:[
                        n.jsx("div",{style:{background:"var(--bg3)",padding:"4px 10px",fontSize:11,color:"var(--text3)"},children:mSrc}),
                        n.jsxs("div",{style:{display:"flex",alignItems:"stretch"},children:[
                              n.jsxs("div",{style:{flex:"1 1 0",display:"flex",alignItems:"center",gap:8,padding:"11px 12px",minWidth:0},children:[
                                    n.jsx("span",{style:{color:"var(--success)",fontSize:13},children:"↙"}),
                                    n.jsx("span",{style:{fontSize:13,color:mIn?"var(--text)":"var(--text3)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"},children:mLd?"Loading…":mIn?pt(mIn):mfm.date?"No clock-in recorded":"--:--"})]}),
                              n.jsx("div",{style:{width:1,background:"var(--border2)"}}),
                              n.jsxs("div",{style:{flex:"1 1 0",display:"flex",alignItems:"center",gap:8,padding:"11px 12px",minWidth:0},children:[
                                    n.jsx("span",{style:{color:"var(--danger)",fontSize:13},children:"↗"}),
                                    n.jsx("span",{style:{fontSize:13,color:mfm.time?"var(--text)":"var(--text3)",whiteSpace:"nowrap"},children:mfm.time?pt(mfm.time):"--:--"})]})]})]}),
                  /* One fixed-height slot for both warnings. They mount and
                     unmount as the day lookup resolves, and the modal is
                     vertically centred — reserving the space is what stops it
                     shifting under the cursor. */
                  n.jsx("div",{style:{minHeight:34,fontSize:12,color:"var(--warn)",marginTop:8},children:mLd?null:mfm.date&&!mAtt?"There is no clock-in on this day — your admin will need to add both times.":mOut?
                      n.jsxs("span",{children:["This day already shows a clock-out of ",pt(mOut),". Submitting will ask your admin to replace it."]}):null}),
                  n.jsx("div",{style:{marginTop:2},children:
                      n.jsx(le,{label:"Note",required:!0,children:
                          n.jsx("textarea",{className:"input-field",rows:3,style:{resize:"vertical"},value:mfm.reason,onChange:function(d){setMF("reason",d.target.value)},placeholder:"Why the clock-out is missing — your admin sees this"})})}),
                  n.jsx("div",{style:{minHeight:18,fontSize:12,color:"var(--danger)",marginTop:-8},children:mfe||null}),
                  n.jsx(Vs,{onCancel:function(){smo(!1);smfe("")},onConfirm:msubmit,confirmLabel:"Send",loading:mbz})]}),
            n.jsxs(Hs,{open:!!cf,onClose:function(){scf(null)},title:"Decline this request?",width:420,children:[
                  n.jsxs("div",{style:{fontSize:13,color:"var(--text2)",lineHeight:1.6},children:["You're about to decline ",
                        n.jsx("strong",{children:cf&&(cf.employee||cf.email)||"this employee"}),"'s ",
                        n.jsx("strong",{children:cf&&cf.type||"leave"})," from ",cf&&prettyD(cf.fromDate)||""," to ",cf&&prettyD(cf.toDate)||""," (",cf&&cf.days||0," days). They'll be notified."]}),cf&&cf.reason?
                  n.jsxs("div",{style:{marginTop:13,padding:"10px 12px",background:"var(--bg3)",borderRadius:8,fontSize:12,color:"var(--text2)",lineHeight:1.5},children:[
                        n.jsx("div",{style:{fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"var(--text2)",marginBottom:4},children:"Their reason"}),cf.reason]}):null,
                  n.jsx(Vs,{onCancel:function(){scf(null)},onConfirm:function(){var t=cf;scf(null);if(t)setSt(t.id,"Rejected")},confirmLabel:"Decline"})]})]})
  };

  console.log('[hrms-leaveui] loaded');
})();
