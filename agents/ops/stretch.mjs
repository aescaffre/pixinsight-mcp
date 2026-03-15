// ============================================================================
// Stretch operations extracted from run-pipeline.mjs
// Seti Statistical Stretch (faithful port of statisticalstretch.js v2.3)
// By Franklin Marek (SetiAstro) — CC BY-NC 4.0
// GHS via PixelMath
// ============================================================================

import { getStats } from './stats.mjs';

// ============================================================================
// Seti Statistical Stretch
// Handles both mono (L_work) and color (RGB) images with proper expressions.
// ============================================================================
export async function setiStretch(ctx, viewId, opts = {}) {
  const targetMedian   = opts.targetMedian ?? 0.25;
  const blackpointSigma = opts.blackpointSigma ?? 5.0;
  const noBlackClip    = opts.noBlackClip ?? false;
  const normalize      = opts.normalize ?? false;
  const hdrCompress    = opts.hdrCompress ?? false;
  const hdrAmount      = opts.hdrAmount ?? 0.25;
  const hdrKnee        = opts.hdrKnee ?? 0.35;
  const hdrHeadroom    = opts.hdrHeadroom ?? 0;
  const maxIterations  = opts.iterations ?? 1;
  const convergenceThreshold = 0.001;

  // Detect if image is color
  const isColorR = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    w.mainView.image.isColor ? 'color' : 'mono';
  `);
  const isColor = (isColorR.outputs?.consoleOutput || '').includes('color');

  const st0 = await getStats(ctx, viewId);
  ctx.log(`    Seti stretch [${isColor ? 'color' : 'mono'}]: target=${targetMedian}, bpSigma=${blackpointSigma}, HDR=${hdrCompress}(amount=${hdrAmount},knee=${hdrKnee},headroom=${hdrHeadroom}), maxIter=${maxIterations}`);
  ctx.log(`    Initial: median=${st0.median.toFixed(6)} (${Math.round(st0.median*65535)} ADU), MAD=${st0.mad.toFixed(6)}, max=${(st0.max ?? 0).toFixed(4)}`);

  const T = targetMedian;
  const noClipFlag = noBlackClip ? '1' : '0';

  for (let iter = 0; iter < maxIterations; iter++) {
    let r;

    // Step 1: Blackpoint / rescale
    let bpExpr, bpSymbols;
    if (isColor) {
      // Color linked: luma-weighted blackpoint (Rec.709), applied uniformly to all channels
      bpExpr = [
        'cr=0.2126; cg=0.7152; cb=0.0722;',
        'Med = cr*med($T[0]) + cg*med($T[1]) + cb*med($T[2]);',
        `Sig = 1.4826*(cr*MAD($T[0]) + cg*MAD($T[1]) + cb*MAD($T[2]));`,
        'MinC = min(min($T[0]),min($T[1]),min($T[2]));',
        `BPraw = Med - ${blackpointSigma}*Sig;`,
        `BP = iif(${noClipFlag}, MinC, iif(BPraw < MinC, MinC, BPraw));`,
        'Rescaled = ($T - BP) / (1 - BP);',
        'Rescaled;'
      ].join('\\n');
      bpSymbols = 'cr,cg,cb,Med,Sig,MinC,BPraw,BP,Rescaled';
    } else {
      // Mono: straightforward per-channel
      bpExpr = [
        'Med = med($T);',
        'Sig = 1.4826*MAD($T);',
        `BPraw = Med - ${blackpointSigma}*Sig;`,
        `BP = iif(${noClipFlag}, min($T), iif(BPraw < min($T), min($T), BPraw));`,
        'Rescaled = ($T - BP) / (1 - BP);',
        'Rescaled;'
      ].join('\\n');
      bpSymbols = 'Med, Sig, BPraw, BP, Rescaled';
    }

    r = await ctx.pjsr(`
      var P = new PixelMath;
      P.expression = "${bpExpr}";
      P.useSingleExpression = true;
      P.symbols = "${bpSymbols}";
      P.use64BitWorkingImage = true;
      P.truncate = false;
      P.createNewImage = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    if (r.status === 'error') { ctx.log(`      WARN step1: ${r.error.message}`); break; }

    // Step 2: Midtones transfer (closed-form MTF mapping median -> targetMedian)
    let mtfExpr, mtfSymbols;
    if (isColor) {
      // Color linked: use average of 3 channel medians as single median
      mtfExpr = `MedianColor = avg(Med($T[0]),Med($T[1]),Med($T[2]));\\n((MedianColor-1)*${T}*$T)/(MedianColor*(${T}+$T-1)-${T}*$T)`;
      mtfSymbols = 'L, MedianColor, S';
    } else {
      // Mono: use Med($T) directly
      mtfExpr = `((Med($T)-1)*${T}*$T)/(Med($T)*(${T}+$T-1)-${T}*$T)`;
      mtfSymbols = 'L, S';
    }

    r = await ctx.pjsr(`
      var P = new PixelMath;
      P.expression = "${mtfExpr}";
      P.useSingleExpression = true;
      P.symbols = "${mtfSymbols}";
      P.use64BitWorkingImage = true;
      P.truncate = false;
      P.createNewImage = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    if (r.status === 'error') { ctx.log(`      WARN step2: ${r.error.message}`); break; }

    // Step 3: Normalize or truncate
    if (normalize) {
      const normExpr = isColor
        ? 'Mcolor=max(max($T[0]),max($T[1]),max($T[2]));\\n$T/Mcolor;'
        : '$T/max($T)';
      r = await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${normExpr}";
        P.useSingleExpression = true;
        P.symbols = "Mcolor";
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
      if (r.status === 'error') ctx.log(`      WARN step3: ${r.error.message}`);
    } else {
      r = await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "$T";
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
    }

    // Step 4: Optional HDR compress (Hermite soft-knee)
    if (hdrCompress && hdrAmount > 0) {
      let hdrExpr, hdrSymbols;
      if (isColor) {
        // Color: compute luma Y, compress Y, scale RGB uniformly by Yc/Y
        hdrExpr = [
          `a = ${hdrAmount};`,
          `k = ${hdrKnee};`,
          'k = min(0.999999, max(0.1, k));',
          'R = $T[0]; G = $T[1]; B = $T[2];',
          'cr = 0.2126; cg = 0.7152; cb = 0.0722;',
          'Y = cr*R + cg*G + cb*B;',
          'hi = Y > k;',
          't = (Y - k)/(1 - k);',
          't = min(1, max(0, t));',
          't2 = t*t;',
          't3 = t2*t;',
          'h10 = (t3 - 2*t2 + t);',
          'h01 = (-2*t3 + 3*t2);',
          'h11 = (t3 - t2);',
          'm1 = min(5, max(1, 1 + 4*a));',
          `ep = ${(1 - hdrHeadroom).toFixed(4)};`,
          'f = h10*1 + h01*ep + h11*m1;',
          'Yc = k + (1 - k)*min(1, max(0, f));',
          's = iif(hi, iif(Y <= 1.0e-10, 1, Yc/Y), 1);',
          '$T * s;'
        ].join('\\n');
        hdrSymbols = 'a,k,x,hi,t,t2,t3,h10,h01,h11,m1,ep,f,y,R,G,B,cr,cg,cb,Y,Yc,s';
      } else {
        // Mono: compress pixel values directly
        hdrExpr = [
          `a = ${hdrAmount};`,
          `k = ${hdrKnee};`,
          'k = min(0.999999, max(0.1, k));',
          'x = $T;',
          'hi = x > k;',
          't = (x - k)/(1 - k);',
          't = min(1, max(0, t));',
          't2 = t*t;',
          't3 = t2*t;',
          'h10 = (t3 - 2*t2 + t);',
          'h01 = (-2*t3 + 3*t2);',
          'h11 = (t3 - t2);',
          'm1 = min(5, max(1, 1 + 4*a));',
          `ep = ${(1 - hdrHeadroom).toFixed(4)};`,
          'f = h10*1 + h01*ep + h11*m1;',
          'y = k + (1 - k)*min(1, max(0, f));',
          'iif(hi, y, x);'
        ].join('\\n');
        hdrSymbols = 'a,k,x,hi,t,t2,t3,h10,h01,h11,m1,ep,f,y';
      }

      r = await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${hdrExpr}";
        P.useSingleExpression = true;
        P.symbols = "${hdrSymbols}";
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
      if (r.status === 'error') ctx.log(`      WARN step4 HDR: ${r.error.message}`);
    }

    // Check convergence
    const stIter = await getStats(ctx, viewId);
    const diff = Math.abs(stIter.median - targetMedian);
    ctx.log(`    Iter ${iter+1}: median=${stIter.median.toFixed(6)} (${Math.round(stIter.median*65535)} ADU), max=${(stIter.max ?? 0).toFixed(4)}, diff=${diff.toFixed(6)}`);

    if (diff < convergenceThreshold) {
      ctx.log(`    Converged after ${iter+1} iteration(s).`);
      break;
    }
  }

  const stFinal = await getStats(ctx, viewId);
  ctx.log(`    Final: median=${stFinal.median.toFixed(6)} (${Math.round(stFinal.median*65535)} ADU), max=${(stFinal.max ?? 0).toFixed(4)}`);
  return stFinal;
}

// ============================================================================
// GHS via PixelMath
// ============================================================================
export function computeGHSCoefficients(orgD, B, SP, LP, HP) {
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

export function buildGHSExpr(c) {
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

export function ghsCode(ctx, viewId, orgD, B, SP, LP, HP) {
  // Validate: HP must be > SP, LP must be < SP
  if (HP <= SP) {
    ctx.log(`    WARN: GHS skipped — HP (${HP}) must be > SP (${SP})`);
    return '/* HP<=SP, skipped */';
  }
  if (LP >= SP) {
    ctx.log(`    WARN: GHS skipped — LP (${LP}) must be < SP (${SP})`);
    return '/* LP>=SP, skipped */';
  }
  const c = computeGHSCoefficients(orgD, B, SP, LP, HP);
  if (!c) return '/* D=0 */';
  const expr = buildGHSExpr(c);
  // Safety check: if NaN leaked into the expression, skip
  if (expr.includes('NaN') || expr.includes('Infinity')) {
    ctx.log(`    WARN: GHS produced NaN/Infinity coefficients — skipped`);
    return '/* NaN coefficients, skipped */';
  }
  return `
    var P = new PixelMath; P.expression = '${expr}'; P.useSingleExpression = true;
    P.createNewImage = false; P.use64BitWorkingImage = true;
    P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `;
}
