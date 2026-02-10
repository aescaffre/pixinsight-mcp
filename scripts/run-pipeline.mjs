import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const home = os.homedir();
const cmdDir = path.join(home, '.pixinsight-mcp/bridge/commands');
const resDir = path.join(home, '.pixinsight-mcp/bridge/results');

function send(tool, proc, params, opts) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cmd = {
      id, timestamp: new Date().toISOString(), tool, process: proc,
      parameters: params,
      executeMethod: opts?.exec || 'executeGlobal',
      targetView: opts?.view || null
    };
    fs.writeFileSync(path.join(cmdDir, id + '.json'), JSON.stringify(cmd, null, 2));
    let att = 0;
    const poll = setInterval(() => {
      const rp = path.join(resDir, id + '.json');
      if (fs.existsSync(rp)) {
        try {
          const r = JSON.parse(fs.readFileSync(rp, 'utf-8'));
          if (r.status === 'running') return;
          clearInterval(poll);
          fs.unlinkSync(rp);
          resolve(r);
        } catch (e) { /* retry */ }
      }
      att++;
      if (att > 2400) { clearInterval(poll); reject(new Error('Timeout: ' + tool)); }
    }, 500);
  });
}

function pjsr(code) { return send('run_script', '__script__', { code }); }
function log(msg) { console.log(msg); }

async function listImages() {
  const list = await send('list_open_images', '__internal__', {});
  return list.outputs?.images || [];
}

async function detectNewImages(beforeIds) {
  const imgs = await listImages();
  return imgs.filter(i => !beforeIds.includes(i.id));
}

async function getStats(viewId) {
  const r = await pjsr(`
    var v = ImageWindow.windowById('${viewId}').mainView;
    var img = v.image;
    var result = {};
    if (img.isColor) {
      var meds = [], mads = [];
      for (var c = 0; c < img.numberOfChannels; c++) {
        img.selectedChannel = c;
        meds.push(img.median());
        mads.push(img.MAD());
      }
      img.resetSelections();
      result.median = (meds[0] + meds[1] + meds[2]) / 3;
      result.mad = (mads[0] + mads[1] + mads[2]) / 3;
    } else {
      result.median = img.median();
      result.mad = img.MAD();
    }
    result.min = img.minimum();
    result.max = img.maximum();
    JSON.stringify(result);
  `);
  try { return JSON.parse(r.outputs?.consoleOutput || '{}'); }
  catch { return { median: 0.01, mad: 0.001 }; }
}

async function autoStretch(viewId, targetBg = 0.25) {
  const stats = await getStats(viewId);
  log(`    Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}`);
  const c0 = Math.max(0, stats.median - 2.8 * stats.mad);
  const x = (1 > c0) ? (stats.median - c0) / (1 - c0) : 0.5;
  let m;
  if (x <= 0 || x >= 1) m = 0.5;
  else m = x * (1 - targetBg) / (x * (1 - 2 * targetBg) + targetBg);
  log(`    Auto-stretch: shadows=${c0.toFixed(6)}, midtone=${m.toFixed(6)}`);
  const r = await pjsr(`
    var P = new HistogramTransformation;
    P.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[${c0},${m},1,0,1],[0,0.5,1,0,1]];
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `);
  if (r.status === 'error') log('    WARN: ' + r.error.message);
  else log('    Stretched OK.');
  return { stats, shadows: c0, midtone: m };
}

// ============================================================================
// GHS via PixelMath
// ============================================================================
function computeGHSCoefficients(orgD, B, SP, LP, HP) {
  const D = Math.exp(orgD) - 1.0;
  if (D === 0) return null;
  let a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,q0,qwp,qlp,q1,q;
  if (B === -1) {
    qlp = -Math.log(1+D*(SP-LP)); q0 = qlp - D*LP/(1+D*(SP-LP));
    qwp = Math.log(1+D*(HP-SP)); q1 = qwp + D*(1-HP)/(1+D*(HP-SP));
    q = 1/(q1-q0);
    a1=0; b1=D/(1+D*(SP-LP))*q;
    a2=-q0*q; b2=-q; c2=1+D*SP; d2=-D; e2=0;
    a3=-q0*q; b3=q; c3=1-D*SP; d3=D; e3=0;
    a4=(qwp-q0-D*HP/(1+D*(HP-SP)))*q; b4=q*D/(1+D*(HP-SP));
    return {type:'log',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  if (B === 0) {
    qlp = Math.exp(-D*(SP-LP)); q0 = qlp - D*LP*Math.exp(-D*(SP-LP));
    qwp = 2 - Math.exp(-D*(HP-SP)); q1 = qwp + D*(1-HP)*Math.exp(-D*(HP-SP));
    q = 1/(q1-q0);
    a1=0; b1=D*Math.exp(-D*(SP-LP))*q;
    a2=-q0*q; b2=q; c2=-D*SP; d2=D; e2=0;
    a3=(2-q0)*q; b3=-q; c3=D*SP; d3=-D; e3=0;
    a4=(qwp-q0-D*HP*Math.exp(-D*(HP-SP)))*q; b4=D*Math.exp(-D*(HP-SP))*q;
    return {type:'exp',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  if (B < 0) {
    const aB = -B;
    qlp = (1-Math.pow(1+D*aB*(SP-LP),(aB-1)/aB))/(aB-1);
    q0 = qlp - D*LP*Math.pow(1+D*aB*(SP-LP),-1/aB);
    qwp = (Math.pow(1+D*aB*(HP-SP),(aB-1)/aB)-1)/(aB-1);
    q1 = qwp + D*(1-HP)*Math.pow(1+D*aB*(HP-SP),-1/aB);
    q = 1/(q1-q0);
    a1=0; b1=D*Math.pow(1+D*aB*(SP-LP),-1/aB)*q;
    a2=(1/(aB-1)-q0)*q; b2=-q/(aB-1); c2=1+D*aB*SP; d2=-D*aB; e2=(aB-1)/aB;
    a3=(-1/(aB-1)-q0)*q; b3=q/(aB-1); c3=1-D*aB*SP; d3=D*aB; e3=(aB-1)/aB;
    a4=(qwp-q0-D*HP*Math.pow(1+D*aB*(HP-SP),-1/aB))*q; b4=D*Math.pow(1+D*aB*(HP-SP),-1/aB)*q;
    return {type:'pow',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  qlp = Math.pow(1+D*B*(SP-LP),-1/B); q0 = qlp - D*LP*Math.pow(1+D*B*(SP-LP),-(1+B)/B);
  qwp = 2 - Math.pow(1+D*B*(HP-SP),-1/B); q1 = qwp + D*(1-HP)*Math.pow(1+D*B*(HP-SP),-(1+B)/B);
  q = 1/(q1-q0);
  a1=0; b1=D*Math.pow(1+D*B*(SP-LP),-(1+B)/B)*q;
  a2=-q0*q; b2=q; c2=1+D*B*SP; d2=-D*B; e2=-1/B;
  a3=(2-q0)*q; b3=-q; c3=1-D*B*SP; d3=D*B; e3=-1/B;
  a4=(qwp-q0-D*HP*Math.pow(1+D*B*(HP-SP),-(B+1)/B))*q; b4=D*Math.pow(1+D*B*(HP-SP),-(B+1)/B)*q;
  return {type:'pow',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
}

function n(v) {
  const s = v.toFixed(12).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  return v < 0 ? `(${s})` : s;
}

function buildGHSExpr(c) {
  let e1,e2,e3,e4;
  if (c.type === 'log') {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*ln(${n(c.c2)}+${n(c.d2)}*$T)`;
    e3=`${n(c.a3)}+${n(c.b3)}*ln(${n(c.c3)}+${n(c.d3)}*$T)`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  } else if (c.type === 'exp') {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*exp(${n(c.c2)}+${n(c.d2)}*$T)`;
    e3=`${n(c.a3)}+${n(c.b3)}*exp(${n(c.c3)}+${n(c.d3)}*$T)`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  } else {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*exp(${n(c.e2)}*ln(${n(c.c2)}+${n(c.d2)}*$T))`;
    e3=`${n(c.a3)}+${n(c.b3)}*exp(${n(c.e3)}*ln(${n(c.c3)}+${n(c.d3)}*$T))`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  }
  let result = e3;
  if (c.HP < 1.0) result = `iif($T<${n(c.HP)},${e3},${e4})`;
  if (c.LP < c.SP) result = `iif($T<${n(c.SP)},${e2},${result})`;
  if (c.LP > 0.0) result = `iif($T<${n(c.LP)},${e1},${result})`;
  return result;
}

function ghsCode(viewId, orgD, B, SP, LP, HP) {
  const c = computeGHSCoefficients(orgD, B, SP, LP, HP);
  if (!c) return '/* D=0 */';
  const expr = buildGHSExpr(c);
  return `
    var P = new PixelMath; P.expression = '${expr}'; P.useSingleExpression = true;
    P.createNewImage = false; P.use64BitWorkingImage = true;
    P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `;
}

// ============================================================================
// SPCC FILTER CURVES (from PixInsight filters.xspd)
// Format: [wavelength_nm, transmission/QE]
// ============================================================================
const ASTRONOMIK_R = [[586,.003],[588,.006],[590,.01],[592,.014],[594,.031],[596,.064],[598,.315],[600,.579],[602,.774],[604,.893],[606,.946],[608,.95],[610,.927],[612,.903],[614,.917],[616,.936],[618,.955],[620,.97],[622,.964],[624,.958],[626,.952],[628,.958],[630,.961],[632,.957],[634,.953],[636,.957],[638,.964],[640,.972],[642,.972],[644,.966],[646,.959],[648,.952],[650,.948],[652,.953],[654,.958],[656,.964],[658,.969],[660,.956],[662,.943],[664,.929],[666,.916],[668,.903],[670,.903],[672,.91],[674,.917],[676,.924],[678,.88],[680,.831],[682,.783],[684,.602],[686,.371],[688,.151],[690,.081],[692,.04],[694,.03],[696,.02],[698,.015],[700,.011],[702,.008],[704,.004]];

const ASTRONOMIK_G = [[484,0],[486,.003],[488,.006],[490,.01],[492,.016],[494,.092],[496,.168],[498,.494],[500,.845],[502,.934],[504,.945],[506,.938],[508,.93],[510,.926],[512,.923],[514,.921],[516,.915],[518,.908],[520,.905],[522,.917],[524,.929],[526,.941],[528,.953],[530,.965],[532,.956],[534,.944],[536,.932],[538,.92],[540,.925],[542,.939],[544,.954],[546,.968],[548,.978],[550,.979],[552,.979],[554,.979],[556,.98],[558,.974],[560,.964],[562,.931],[564,.869],[566,.806],[568,.337],[570,.114],[572,.051],[574,.013],[576,.01],[578,.006],[580,.002],[582,0]];

const ASTRONOMIK_B = [[416,.004],[418,.013],[420,.033],[422,.053],[424,.202],[426,.698],[428,.867],[430,.953],[432,.953],[434,.951],[436,.945],[438,.951],[440,.958],[442,.962],[444,.96],[446,.965],[448,.967],[450,.96],[452,.951],[454,.947],[456,.949],[458,.96],[460,.967],[462,.965],[464,.965],[466,.966],[468,.966],[470,.967],[472,.962],[474,.96],[476,.958],[478,.961],[480,.963],[482,.967],[484,.969],[486,.962],[488,.959],[490,.959],[492,.957],[494,.954],[496,.952],[498,.949],[500,.947],[502,.938],[504,.929],[506,.925],[508,.916],[510,.889],[512,.539],[514,.151],[516,.042],[518,.017],[520,.005],[522,0]];

const SONY_IMX411_QE = [[402,.7219],[404,.7367],[406,.75],[408,.7618],[410,.7751],[412,.787],[414,.7944],[416,.8018],[418,.8112],[420,.8214],[422,.8343],[424,.8462],[426,.8536],[428,.8595],[430,.8639],[432,.8713],[434,.8757],[436,.8802],[438,.8861],[440,.8905],[442,.895],[444,.8994],[446,.9038],[448,.9068],[450,.9112],[452,.9142],[454,.9172],[456,.9168],[458,.9151],[460,.9134],[462,.9117],[464,.91],[466,.9083],[468,.9066],[470,.9049],[472,.9032],[474,.9015],[476,.8997],[478,.898],[480,.8963],[482,.8946],[484,.8929],[486,.8912],[488,.8876],[490,.8846],[492,.8877],[494,.8904],[496,.893],[498,.8964],[500,.8964],[502,.895],[504,.8945],[506,.8922],[508,.8899],[510,.8876],[512,.8853],[514,.883],[516,.8807],[518,.8784],[520,.8761],[522,.8743],[524,.8728],[526,.8698],[528,.8669],[530,.8624],[532,.858],[534,.855],[536,.8506],[538,.8476],[540,.8432],[542,.8402],[544,.8358],[546,.8328],[548,.8284],[550,.8254],[552,.821],[554,.8166],[556,.8136],[558,.8092],[560,.8062],[562,.8023],[564,.7983],[566,.7944],[568,.7899],[570,.787],[572,.7825],[574,.7781],[576,.7751],[578,.7707],[580,.7663],[582,.7618],[584,.7559],[586,.75],[588,.7441],[590,.7396],[592,.7337],[594,.7278],[596,.7219],[598,.716],[600,.7101],[602,.7056],[604,.6997],[606,.695],[608,.6905],[610,.6852],[612,.6808],[614,.6763],[616,.6719],[618,.6675],[620,.663],[622,.6583],[624,.6553],[626,.6509],[628,.6464],[630,.642],[632,.6376],[634,.6317],[636,.6272],[638,.6213],[640,.6154],[642,.6109],[644,.6036],[646,.5962],[648,.5902],[650,.5843],[652,.5799],[654,.574],[656,.5695],[658,.5636],[660,.5592],[662,.5545],[664,.5504],[666,.5462],[668,.542],[670,.5378],[672,.5328],[674,.5286],[676,.5244],[678,.5203],[680,.5163],[682,.5133],[684,.5089],[686,.5044],[688,.4985],[690,.4926],[692,.4867],[694,.4793],[696,.4719],[698,.4645],[700,.4586],[702,.4541],[704,.4497],[706,.4453],[708,.4408],[710,.4364],[712,.432],[714,.4275],[716,.4216],[718,.4186],[720,.4142],[722,.4127],[724,.4103],[726,.4078],[728,.4053],[730,.4024],[732,.3979],[734,.3935],[736,.3891],[738,.3831],[740,.3802],[742,.3772],[744,.3743],[746,.3713],[748,.3669],[750,.3624],[752,.3595],[754,.3559],[756,.3526],[758,.3494],[760,.3462],[762,.3429],[764,.3397],[766,.3364],[768,.3332],[770,.33],[772,.3267],[774,.3235],[776,.3203],[778,.317],[780,.3138],[782,.3106],[784,.3073],[786,.3041],[788,.3009],[790,.2976],[792,.2937],[794,.2905],[796,.2873],[798,.284],[800,.2808],[802,.2776],[804,.2743],[806,.2731],[808,.2703],[810,.2674],[812,.2646],[814,.2618],[816,.2589],[818,.2561],[820,.2533],[822,.2504],[824,.2476],[826,.2456],[828,.2439],[830,.2433],[832,.2427],[834,.2421],[836,.2416],[838,.2411],[840,.2382],[842,.2322],[844,.2278],[846,.2219],[848,.2175],[850,.2114],[852,.2069],[854,.2023],[856,.1978],[858,.1932],[860,.1918],[862,.1911],[864,.1904],[866,.1897],[868,.189],[870,.1883],[872,.1879],[874,.1834],[876,.179],[878,.1731],[880,.1672],[882,.1612],[884,.1568],[886,.1524],[888,.1479],[890,.1464],[892,.1464],[894,.1464],[896,.1464],[898,.1481],[900,.1494],[902,.1494],[904,.1494],[906,.1464],[908,.1435],[910,.1391],[912,.1346],[914,.1302],[916,.1257],[918,.1228],[920,.1183],[922,.1139],[924,.1109],[926,.1093],[928,.1085],[930,.108],[932,.108],[934,.108],[936,.108],[938,.108],[940,.1058],[942,.1039],[944,.1021],[946,.0998],[948,.0958],[950,.0918],[952,.0888],[954,.0828],[956,.0769],[958,.074],[960,.0714],[962,.0695],[964,.0677],[966,.0658],[968,.0651],[970,.0636],[972,.0626],[974,.0616],[976,.0606],[978,.0596],[980,.0586],[982,.0576],[984,.0567],[986,.0557],[988,.0547],[990,.0537],[992,.0527],[994,.0517],[996,.0507]];

// Convert curve array to flat comma string: w1,v1,w2,v2,...
function curveToFlat(arr) {
  return arr.map(p => p[0] + ',' + p[1]).join(',');
}

// ============================================================================
// SOURCE FILES
// ============================================================================
const DATA_DIR = '/Users/aescaffre/Bubble Nebulae/Output/claude';
const MASTER_DIR = '/Users/aescaffre/Bubble Nebulae/Output/master';
const FILE_R  = `${DATA_DIR}/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-R_mono_autocrop.xisf`;
const FILE_V  = `${DATA_DIR}/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-V_mono_autocrop.xisf`;
const FILE_B  = `${DATA_DIR}/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-B_mono_autocrop.xisf`;
const FILE_HA = `${DATA_DIR}/Ha_Linear.xisf`;
const OUTPUT_DIR = `${DATA_DIR}/claude_processed`;

// ============================================================================
// MAIN PIPELINE v5
// Order: ABE(each) → Combine → SPCC → SCNR → BXT(correct) → NXT → BXT(sharp)
//        → SXT → Stretch → Curves → Ha enhance → Ha inject → Light NXT
//        → Final curves → Star recombine → Save
// ============================================================================
async function run() {
  // ==== PHASE 0: SETUP ====
  log('==== PHASE 0: SETUP ====');
  log('Closing all open images...');
  let imgs = await listImages();
  if (imgs.length > 0) {
    const ids = imgs.map(i => "'" + i.id + "'").join(',');
    await pjsr(`var ids=[${ids}]; for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(w)w.forceClose();processEvents();}`);
  }

  log('Opening R, V, B, Ha...');
  const rR = await send('open_image', '__internal__', { filePath: FILE_R });
  if (rR.status === 'error') { log('FATAL: ' + rR.error.message); process.exit(1); }
  log('  R: ' + rR.outputs.id + ' (' + rR.outputs.width + 'x' + rR.outputs.height + ')');
  const rV = await send('open_image', '__internal__', { filePath: FILE_V });
  log('  V: ' + rV.outputs.id);
  const rB = await send('open_image', '__internal__', { filePath: FILE_B });
  log('  B: ' + rB.outputs.id);
  const rHa = await send('open_image', '__internal__', { filePath: FILE_HA });
  log('  Ha: ' + rHa.outputs.id + ' (' + rHa.outputs.width + 'x' + rHa.outputs.height + ') [non-linear, starless]');

  // Close XISF crop masks
  imgs = await listImages();
  for (const cm of imgs.filter(i => i.id.indexOf('crop_mask') >= 0)) {
    await pjsr(`var w=ImageWindow.windowById('${cm.id}');if(w)w.forceClose();`);
  }

  imgs = await listImages();
  const findView = (f) => imgs.find(i => i.id.toUpperCase().indexOf(f) >= 0);
  const viewR = findView('FILTER_R') || findView('FILTER-R');
  const viewV = findView('FILTER_V') || findView('FILTER-V');
  const viewB = findView('FILTER_B') || findView('FILTER-B');
  const viewHa = imgs.find(i => i.id.indexOf('Ha') >= 0 || i.id.indexOf('ha') >= 0);
  if (!viewR || !viewV || !viewB || !viewHa) { log('FATAL: Missing images'); process.exit(1); }
  const idR = viewR.id, idV = viewV.id, idB = viewB.id, idHa = viewHa.id;
  const rgbW = viewR.width, rgbH = viewR.height;
  log('Identified: R=' + idR + ' V=' + idV + ' B=' + idB + ' Ha=' + idHa);

  // ==== PHASE 1: COMBINE + ALIGN Ha ====
  log('\n==== PHASE 1: COMBINE RGB + ALIGN Ha ====');

  // Ha is starless — DynamicCrop to match RGB dimensions
  imgs = await listImages();
  const haView = imgs.find(i => i.id === idHa);
  const haW = haView?.width || rHa.outputs.width;
  const haH = haView?.height || rHa.outputs.height;
  if (haW !== rgbW || haH !== rgbH) {
    log('  DynamicCrop Ha (' + haW + 'x' + haH + ') -> (' + rgbW + 'x' + rgbH + ')...');
    await pjsr(`
      var P = new DynamicCrop; P.centerX=0.5; P.centerY=0.5;
      P.width=${rgbW}/${haW}; P.height=${rgbH}/${haH};
      P.executeOn(ImageWindow.windowById('${idHa}').mainView);
    `);
    log('    Done.');
  } else {
    log('  Ha already matches RGB dimensions.');
  }

  log('  Creating RGB composite (BubbleNebula)...');
  let r = await pjsr(`
    var P = new PixelMath;
    P.expression='${idR}'; P.expression1='${idV}'; P.expression2='${idB}';
    P.useSingleExpression=false; P.createNewImage=true; P.showNewImage=true;
    P.newImageId='BubbleNebula'; P.newImageWidth=${rgbW}; P.newImageHeight=${rgbH};
    P.newImageColorSpace=PixelMath.prototype.RGB; P.newImageSampleFormat=PixelMath.prototype.f32;
    P.executeGlobal();
  `);
  if (r.status === 'error') { log('FATAL: ' + r.error.message); process.exit(1); }

  log('  Copying astrometry from R...');
  await pjsr(`
    var s=ImageWindow.windowById('${idR}'), d=ImageWindow.windowById('BubbleNebula');
    if(s&&d&&s.hasAstrometricSolution) d.copyAstrometricSolution(s);
  `);

  log('  Cloning Ha -> Ha_work...');
  await pjsr(`
    var P=new PixelMath; P.expression='${idHa}'; P.useSingleExpression=true;
    P.createNewImage=true; P.showNewImage=true; P.newImageId='Ha_work';
    P.newImageWidth=${rgbW}; P.newImageHeight=${rgbH};
    P.newImageColorSpace=PixelMath.prototype.Gray; P.newImageSampleFormat=PixelMath.prototype.f32;
    P.executeGlobal();
  `);

  log('  Closing original masters...');
  await pjsr(`
    var ids=['${idR}','${idV}','${idB}','${idHa}'];
    for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(w)w.forceClose();processEvents();}
  `);

  // ==== PHASE 2: ABE ON COMPOSITE ====
  log('\n==== PHASE 2: ABE ====');
  let beforeAbe = (await listImages()).map(i => i.id);
  r = await pjsr(`
    var P = new AutomaticBackgroundExtractor;
    P.polyDegree = 4;
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
  // Close ABE background model
  let abeModels = await detectNewImages(beforeAbe);
  if (abeModels.length > 0) {
    const closeIds = abeModels.map(i => "'" + i.id + "'").join(',');
    await pjsr(`var ids=[${closeIds}];for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(w)w.forceClose();processEvents();}`);
  }

  // ==== PHASE 3: BXT correctOnly ====
  log('\n==== PHASE 3: BXT (correctOnly) ====');
  r = await pjsr(`
    var P = new BlurXTerminator;
    P.sharpenStars=0.50; P.adjustStarHalos=0.00;
    P.sharpenNonstellar=0.75; P.correctOnly=true;
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

  // ==== PHASE 4: SPCC + SCNR ====
  log('\n==== PHASE 4: SPCC (Astronomik Deep Sky + Sony IMX411) ====');

  // Write curves as JSON (flat comma format: w1,v1,w2,v2,...)
  const spccCurves = {
    red: curveToFlat(ASTRONOMIK_R),
    green: curveToFlat(ASTRONOMIK_G),
    blue: curveToFlat(ASTRONOMIK_B),
    qe: curveToFlat(SONY_IMX411_QE)
  };
  fs.writeFileSync('/tmp/spcc-curves.json', JSON.stringify(spccCurves));

  r = await pjsr(`
    var json = File.readLines('/tmp/spcc-curves.json').join('');
    var c = JSON.parse(json);
    var P = new SpectrophotometricColorCalibration;
    P.whiteReferenceName = 'Average Spiral Galaxy';
    P.deviceQECurveName = 'Sony IMX411/455/461/533/571';
    P.deviceQECurve = c.qe;
    P.redFilterName = 'Astronomik Deep Sky R';
    P.redFilterTrCurve = c.red;
    P.greenFilterName = 'Astronomik Deep Sky G';
    P.greenFilterTrCurve = c.green;
    P.blueFilterName = 'Astronomik Deep Sky B';
    P.blueFilterTrCurve = c.blue;
    P.narrowbandMode = false;
    P.generateGraphs = false;
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

  log('  SCNR (green removal)...');
  r = await pjsr(`
    var P = new SCNR; P.colorToRemove = 1; P.amount = 1.0;
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

  // ==== PHASE 5: BXT sharpening ====
  log('\n==== PHASE 5: BXT (sharpening) ====');
  r = await pjsr(`
    var P = new BlurXTerminator;
    P.sharpenStars=0.40; P.adjustStarHalos=0.00;
    P.sharpenNonstellar=0.75; P.correctOnly=false;
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

  // ==== PHASE 6: NXT pass 1 (denoise=0.3) ====
  log('\n==== PHASE 6: NXT pass 1 (denoise=0.3) ====');
  r = await pjsr(`
    var P = new NoiseXTerminator; P.denoise=0.30; P.detail=0.15;
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

  // ==== PHASE 7: SXT ====
  log('\n==== PHASE 7: SXT (star removal) ====');
  let beforeSxt = (await listImages()).map(i => i.id);
  r = await pjsr(`
    var P = new StarXTerminator; P.stars=true; P.overlap=0.20;
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
  let newStarImgs = await detectNewImages(beforeSxt);
  const starsId = newStarImgs.length > 0 ? newStarImgs[0].id : null;
  log('  Stars: ' + (starsId || 'NOT DETECTED'));

  // ==== PHASE 8: STRETCH ====
  log('\n==== PHASE 8: STRETCH (HT + GHS) ====');

  log('  8a: AutoStretch (HT)...');
  const mainHT = await autoStretch('BubbleNebula', 0.25);
  let postStats = await getStats('BubbleNebula');
  log('  Post-stretch median: ' + postStats.median.toFixed(4));

  log('  8b: GHS refinement...');
  for (const [desc, d, b, lp, hp] of [
    ['Midtone boost', 0.8, -1.0, 0.02, 0.95],
    ['Fine contrast', 0.5, -1.5, 0.03, 0.90],
  ]) {
    const st = await getStats('BubbleNebula');
    log(`    ${desc} (D=${d}, SP=${st.median.toFixed(4)})...`);
    r = await pjsr(ghsCode('BubbleNebula', d, b, st.median, lp, hp));
    log('      ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
  }

  // ==== PHASE 9: NXT pass 2 (denoise=0.6, post-stretch) ====
  log('\n==== PHASE 9: NXT pass 2 (denoise=0.6) ====');
  r = await pjsr(`
    var P = new NoiseXTerminator; P.denoise=0.60; P.detail=0.15;
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

  // ==== PHASE 10: CURVES ====
  log('\n==== PHASE 10: CURVES (contrast + saturation) ====');

  log('  10a: Contrast S-curve...');
  await pjsr(`
    var P=new CurvesTransformation;
    P.K=[[0,0],[0.10,0.06],[0.50,0.55],[0.90,0.95],[1,1]];
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);

  log('  10b: Saturation boost...');
  await pjsr(`
    var P=new CurvesTransformation;
    P.S=[[0,0],[0.50,0.62],[1,1]];
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);

  // ==== PHASE 11: Ha ENHANCEMENT + INJECTION ====
  log('\n==== PHASE 11: Ha ENHANCEMENT + INJECTION ====');

  log('  11a: Ha curves (detail)...');
  await pjsr(`
    var P=new CurvesTransformation;
    P.K=[[0,0],[0.15,0.10],[0.50,0.55],[0.85,0.92],[1,1]];
    P.executeOn(ImageWindow.windowById('Ha_work').mainView);
  `);

  log('  11b: Ha GHS refinement...');
  const haSt = await getStats('Ha_work');
  r = await pjsr(ghsCode('Ha_work', 0.5, -1.0, haSt.median, 0.02, 0.95));
  log('    ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

  log('  11c: LinearFit Ha to R channel...');
  await pjsr(`
    var P=new PixelMath; P.expression='BubbleNebula'; P.useSingleExpression=true;
    P.createNewImage=true; P.showNewImage=true; P.newImageId='R_temp';
    P.newImageWidth=${rgbW}; P.newImageHeight=${rgbH};
    P.newImageColorSpace=PixelMath.prototype.Gray; P.newImageSampleFormat=PixelMath.prototype.f32;
    P.executeGlobal();
  `);
  r = await pjsr(`
    var P=new LinearFit; P.referenceViewId='R_temp'; P.rejectLow=0.0; P.rejectHigh=0.92;
    P.executeOn(ImageWindow.windowById('Ha_work').mainView);
  `);
  log('    ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
  await pjsr(`var w=ImageWindow.windowById('R_temp');if(w)w.forceClose();`);

  log('  11d: Inject Ha into R channel (strength=0.5)...');
  r = await pjsr(`
    var P=new PixelMath;
    P.expression='iif(Ha_work>$T,$T+(0.5*(Ha_work-med(Ha_work))),$T)';
    P.expression1='$T'; P.expression2='$T';
    P.useSingleExpression=false; P.createNewImage=false;
    P.use64BitWorkingImage=true; P.truncate=true; P.truncateLower=0; P.truncateUpper=1;
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('    ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

  // ==== PHASE 12: FINAL CURVES ====
  log('\n==== PHASE 12: FINAL CURVES ====');
  log('  Gentle lightness/color refinement...');
  await pjsr(`
    var P=new CurvesTransformation;
    P.K=[[0,0],[0.15,0.12],[0.50,0.52],[0.85,0.88],[1,1]];
    P.S=[[0,0],[0.45,0.52],[1,1]];
    P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
  `);
  log('  Done.');

  // ==== PHASE 13: STAR RECOMBINATION ====
  log('\n==== PHASE 13: STAR RECOMBINATION ====');
  if (starsId) {
    log('  13a: Stretch stars (same HT as main)...');
    const c0 = mainHT.shadows;
    const x0 = (1 > c0) ? (mainHT.stats.median - c0) / (1 - c0) : 0.5;
    const m0 = (x0 > 0 && x0 < 1) ? x0 * 0.75 / (x0 * 0.5 + 0.25) : 0.5;
    log(`    HT: shadows=${c0.toFixed(6)}, midtone=${m0.toFixed(6)}`);
    await pjsr(`
      var P=new HistogramTransformation;
      P.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[${c0},${m0},1,0,1],[0,0.5,1,0,1]];
      P.executeOn(ImageWindow.windowById('${starsId}').mainView);
    `);

    log('  13b: Star saturation boost...');
    await pjsr(`
      var P=new CurvesTransformation;
      P.S=[[0,0],[0.35,0.55],[0.65,0.85],[1,1]];
      P.executeOn(ImageWindow.windowById('${starsId}').mainView);
    `);

    log('  13c: Screen blend stars...');
    r = await pjsr(`
      var P=new PixelMath; P.expression='~(~$T*~${starsId})';
      P.useSingleExpression=true; P.createNewImage=false;
      P.executeOn(ImageWindow.windowById('BubbleNebula').mainView);
    `);
    log('    ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
  } else {
    log('  No stars to recombine.');
  }

  // ==== PHASE 14: SAVE & CLEANUP ====
  log('\n==== PHASE 14: SAVE & CLEANUP ====');
  const outputPath = `${OUTPUT_DIR}/BubbleNebula_HaRGB.xisf`;
  r = await pjsr(`
    var dir='${OUTPUT_DIR}';
    if(!File.directoryExists(dir)) File.createDirectory(dir,true);
    var w=ImageWindow.windowById('BubbleNebula');
    var p='${outputPath}';
    if(File.exists(p)) File.remove(p);
    w.saveAs(p,false,false,false,false);
    var all=ImageWindow.windows;
    for(var i=all.length-1;i>=0;i--){
      if(all[i].mainView.id!=='BubbleNebula'){all[i].forceClose();}
      processEvents();
    }
    'Saved and cleaned up';
  `);
  log('  ' + (r.outputs?.consoleOutput || r.error?.message || 'Done.'));

  const finalStats = await getStats('BubbleNebula');
  log('\n========================================');
  log('  PIPELINE v6 COMPLETE');
  log('========================================');
  log('  Combine -> ABE -> BXT(correct) -> SPCC(Astronomik) -> SCNR');
  log('  -> BXT(sharpen) -> NXT(0.3) -> SXT');
  log('  -> Stretch(HT+GHS) -> NXT(0.6) -> Curves');
  log('  -> Ha(enhance+inject) -> Final curves -> Star recombine');
  log('  Final median: ' + finalStats.median.toFixed(4));
  log('  Output: ' + outputPath);
  log('========================================');
}

run().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
