#!/usr/bin/env node
// Minimal SPCC test — combine RGB, create WCS, run SPCC
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
      if (att > 1200) { clearInterval(poll); reject(new Error('Timeout: ' + tool)); }
    }, 500);
  });
}

async function pjsr(code) {
  const r = await send('run_script', '__script__', { code });
  r.result = r.outputs?.consoleOutput;
  if (r.status !== 'error') r.status = 'ok';
  return r;
}

// Filter curves
const ASTRONOMIK_R = [[586,.003],[588,.006],[590,.01],[592,.014],[594,.031],[596,.064],[598,.315],[600,.579],[602,.774],[604,.893],[606,.946],[608,.95],[610,.927],[612,.903],[614,.917],[616,.936],[618,.955],[620,.97],[622,.964],[624,.958],[626,.952],[628,.958],[630,.961],[632,.957],[634,.953],[636,.957],[638,.964],[640,.972],[642,.972],[644,.966],[646,.959],[648,.952],[650,.948],[652,.953],[654,.958],[656,.964],[658,.969],[660,.956],[662,.943],[664,.929],[666,.916],[668,.903],[670,.903],[672,.91],[674,.917],[676,.924],[678,.88],[680,.831],[682,.783],[684,.602],[686,.371],[688,.151],[690,.081],[692,.04],[694,.03],[696,.02],[698,.015],[700,.011],[702,.008],[704,.004]];
const ASTRONOMIK_G = [[484,0],[486,.003],[488,.006],[490,.01],[492,.016],[494,.092],[496,.168],[498,.494],[500,.845],[502,.934],[504,.945],[506,.938],[508,.93],[510,.926],[512,.923],[514,.921],[516,.915],[518,.908],[520,.905],[522,.917],[524,.929],[526,.941],[528,.953],[530,.965],[532,.956],[534,.944],[536,.932],[538,.92],[540,.925],[542,.939],[544,.954],[546,.968],[548,.978],[550,.979],[552,.979],[554,.979],[556,.98],[558,.974],[560,.964],[562,.931],[564,.869],[566,.806],[568,.337],[570,.114],[572,.051],[574,.013],[576,.01],[578,.006],[580,.002],[582,0]];
const ASTRONOMIK_B = [[416,.004],[418,.013],[420,.033],[422,.053],[424,.202],[426,.698],[428,.867],[430,.953],[432,.953],[434,.951],[436,.945],[438,.951],[440,.958],[442,.962],[444,.96],[446,.965],[448,.967],[450,.96],[452,.951],[454,.947],[456,.949],[458,.96],[460,.967],[462,.965],[464,.965],[466,.966],[468,.966],[470,.967],[472,.962],[474,.96],[476,.958],[478,.961],[480,.963],[482,.967],[484,.969],[486,.962],[488,.959],[490,.959],[492,.957],[494,.954],[496,.952],[498,.949],[500,.947],[502,.938],[504,.929],[506,.925],[508,.916],[510,.889],[512,.539],[514,.151],[516,.042],[518,.017],[520,.005],[522,0]];
const SONY_IMX411_QE = [[402,.7219],[404,.7367],[406,.75],[408,.7618],[410,.7751],[412,.787],[414,.7944],[416,.8018],[418,.8112],[420,.8214],[422,.8343],[424,.8462],[426,.8536],[428,.8595],[430,.8639],[432,.8713],[434,.8757],[436,.8802],[438,.8861],[440,.8905],[442,.895],[444,.8994],[446,.9038],[448,.9068],[450,.9112],[452,.9142],[454,.9172],[456,.9168],[458,.9151],[460,.9134],[462,.9117],[464,.91],[466,.9083],[468,.9066],[470,.9049],[472,.9032],[474,.9015],[476,.8997],[478,.898],[480,.8963],[482,.8946],[484,.8929],[486,.8912],[488,.8876],[490,.8846],[492,.8877],[494,.8904],[496,.893],[498,.8964],[500,.8964],[502,.895],[504,.8945],[506,.8922],[508,.8899],[510,.8876],[512,.8853],[514,.883],[516,.8807],[518,.8784],[520,.8761],[522,.8743],[524,.8728],[526,.8698],[528,.8669],[530,.8624],[532,.858],[534,.855],[536,.8506],[538,.8476],[540,.8432],[542,.8402],[544,.8358],[546,.8328],[548,.8284],[550,.8254],[552,.821],[554,.8166],[556,.8136],[558,.8092],[560,.8062],[562,.8023],[564,.7983],[566,.7944],[568,.7899],[570,.787],[572,.7825],[574,.7781],[576,.7751],[578,.7707],[580,.7663],[582,.7618],[584,.7559],[586,.75],[588,.7441],[590,.7396],[592,.7337],[594,.7278],[596,.7219],[598,.716],[600,.7101],[602,.7056],[604,.6997],[606,.695],[608,.6905],[610,.6852],[612,.6808],[614,.6763],[616,.6719],[618,.6675],[620,.663],[622,.6583],[624,.6553],[626,.6509],[628,.6464],[630,.642],[632,.6376],[634,.6317],[636,.6272],[638,.6213],[640,.6154],[642,.6109],[644,.6036],[646,.5962],[648,.5902],[650,.5843],[652,.5799],[654,.574],[656,.5695],[658,.5636],[660,.5592],[662,.5545],[664,.5504],[666,.5462],[668,.542],[670,.5378],[672,.5328],[674,.5286],[676,.5244],[678,.5203],[680,.5163],[682,.5133],[684,.5089],[686,.5044],[688,.4985],[690,.4926],[692,.4867],[694,.4793],[696,.4719],[698,.4645],[700,.4586],[702,.4541],[704,.4497],[706,.4453],[708,.4408],[710,.4364],[712,.432],[714,.4275],[716,.4216],[718,.4186],[720,.4142],[722,.4127],[724,.4103],[726,.4078],[728,.4053],[730,.4024],[732,.3979],[734,.3935],[736,.3891],[738,.3831],[740,.3802],[742,.3772],[744,.3743],[746,.3713],[748,.3669],[750,.3624],[752,.3595],[754,.3559],[756,.3526],[758,.3494],[760,.3462],[762,.3429],[764,.3397],[766,.3364],[768,.3332],[770,.33],[772,.3267],[774,.3235],[776,.3203],[778,.317],[780,.3138],[782,.3106],[784,.3073],[786,.3041],[788,.3009],[790,.2976],[792,.2937],[794,.2905],[796,.2873],[798,.284],[800,.2808],[802,.2776],[804,.2743],[806,.2731],[808,.2703],[810,.2674],[812,.2646],[814,.2618],[816,.2589],[818,.2561],[820,.2533],[822,.2504],[824,.2476],[826,.2456],[828,.2439],[830,.2433],[832,.2427],[834,.2421],[836,.2416],[838,.2411],[840,.2382],[842,.2322],[844,.2278],[846,.2219],[848,.2175],[850,.2114],[852,.2069],[854,.2023],[856,.1978],[858,.1932],[860,.1918],[862,.1911],[864,.1904],[866,.1897],[868,.189],[870,.1883],[872,.1879],[874,.1834],[876,.179],[878,.1731],[880,.1672],[882,.1612],[884,.1568],[886,.1524],[888,.1479],[890,.1464],[892,.1464],[894,.1464],[896,.1464],[898,.1481],[900,.1494],[902,.1494],[904,.1494],[906,.1464],[908,.1435],[910,.1391],[912,.1346],[914,.1302],[916,.1257],[918,.1228],[920,.1183],[922,.1139],[924,.1109],[926,.1093],[928,.1085],[930,.108],[932,.108],[934,.108],[936,.108],[938,.108],[940,.1058],[942,.1039],[944,.1021],[946,.0998],[948,.0958],[950,.0918],[952,.0888],[954,.0828],[956,.0769],[958,.074],[960,.0714],[962,.0695],[964,.0677],[966,.0658],[968,.0651],[970,.0636],[972,.0626],[974,.0616],[976,.0606],[978,.0596],[980,.0586],[982,.0576],[984,.0567],[986,.0557],[988,.0547],[990,.0537],[992,.0527],[994,.0517],[996,.0507]];
const WHITE_REF_AVG_SPIRAL = "200.5,0.0715066,201.5,0.0689827,202.5,0.0720216,203.5,0.0685511,204.5,0.0712370,205.5,0.0680646,206.5,0.0683024,207.4,0.0729174,207.8,0.0702124,208.5,0.0727025,209.5,0.0688880,210.5,0.0690528,211.5,0.0697566,212.5,0.0705508,213.5,0.0654581,214.5,0.0676317,215.5,0.0699038,216.5,0.0674922,217.5,0.0668344,218.5,0.0661763,219.5,0.0690803,220.5,0.0670864,221.5,0.0635644,222.5,0.0619833,223.5,0.0668687,224.5,0.0640725,225.5,0.0614358,226.5,0.0628698,227.5,0.0649014,228.5,0.0673391,229.5,0.0638038,230.5,0.0643234,231.5,0.0614849,232.5,0.0493110,233.5,0.0574873,234.5,0.0555616,235.5,0.0609369,236.5,0.0557384,237.5,0.0578991,238.5,0.0536321,239.5,0.0575370,240.5,0.0555389,241.5,0.0571506,242.5,0.0615309,243.5,0.0595363,244.5,0.0634798,245.5,0.0628886,246.5,0.0622975,247.5,0.0600475,248.5,0.0608933,249.5,0.0580972,250.5,0.0653082,251.3,0.0576207,251.8,0.0588533,252.5,0.0566401,253.5,0.0582714,254.5,0.0575809,255.5,0.0633762,256.5,0.0610093,257.5,0.0652874,258.5,0.0642648,259.5,0.0632596,260.5,0.0609384,261.5,0.0600490,262.5,0.0636409,263.5,0.0682040,264.5,0.0754600,265.5,0.0806341,266.5,0.0699754,267.5,0.0739405,268.5,0.0755243,269.5,0.0697483,270.5,0.0736132,271.5,0.0678854,272.5,0.0663086,273.5,0.0709825,274.5,0.0602999,275.5,0.0630128,276.5,0.0669431,277.5,0.0701399,278.5,0.0641577,279.5,0.0511231,280.5,0.0550197,281.5,0.0692974,282.5,0.0753517,283.5,0.0723537,284.5,0.0679725,285.5,0.0634174,286.5,0.0742486,287.5,0.0783316,288.5,0.0771108,289.5,0.0801337,291,0.0914252,293,0.0862422,295,0.0838485,297,0.0858467,299,0.0865643,301,0.0875161,303,0.0893837,305,0.0905257,307,0.0935800,309,0.0934870,311,0.0982195,313,0.0953176,315,0.0961554,317,0.0995933,319,0.0924967,321,0.0978345,323,0.0907337,325,0.1054383,327,0.1143168,329,0.1135342,331,0.1106139,333,0.1119505,335,0.1099062,337,0.0967928,339,0.1022504,341,0.1039447,343,0.1063681,345,0.1091599,347,0.1109753,349,0.1181664,351,0.1232860,353,0.1163073,355,0.1267769,357,0.1035215,359,0.1042786,361,0.1176823,363,0.1219479,364,0.1250342,365,0.1363934,367,0.1407033,369,0.1288466,371,0.1379791,373,0.1127623,375,0.1318217,377,0.1528880,379,0.1670432,381,0.1727864,383,0.1243124,385,0.1639393,387,0.1724457,389,0.1520460,391,0.2043430,393,0.1427526,395,0.1870668,397,0.1244026,399,0.2329267,401,0.2556144,403,0.2542109,405,0.2491356,407,0.2379803,409,0.2541684,411,0.2279309,413,0.2533629,415,0.2557223,417,0.2584198,419,0.2560216,421,0.2587210,423,0.2498130,425,0.2609755,427,0.2495886,429,0.2412927,431,0.2182856,433,0.2579985,435,0.2483036,437,0.2928112,439,0.2713431,441,0.2828921,443,0.2975108,445,0.3012513,447,0.3161393,449,0.3221464,451,0.3585586,453,0.3219299,455,0.3334392,457,0.3568741,459,0.3412296,461,0.3498501,463,0.3424920,465,0.3478877,467,0.3611478,469,0.3560448,471,0.3456585,473,0.3587672,475,0.3690553,477,0.3657369,479,0.3671625,481,0.3666357,483,0.3761265,485,0.3466382,487,0.3121751,489,0.3651561,491,0.3688824,493,0.3627420,495,0.3786295,497,0.3733906,499,0.3510300,501,0.3338136,503,0.3540298,505,0.3527861,507,0.3680833,509,0.3507047,511,0.3597249,513,0.3486136,515,0.3372089,517,0.3152444,519,0.3257755,521,0.3499922,523,0.3744245,525,0.3907778,527,0.3490228,529,0.3972061,531,0.4203442,533,0.3740999,535,0.4084084,537,0.4070036,539,0.3993480,541,0.3942389,543,0.4010466,545,0.4128880,547,0.4055525,549,0.4094232,551,0.4053814,553,0.4201633,555,0.4269231,557,0.4193749,559,0.4105311,561,0.4257824,563,0.4239540,565,0.4310873,567,0.4218358,569,0.4360353,571,0.4229342,573,0.4583894,575,0.4425389,577,0.4481210,579,0.4320856,581,0.4507180,583,0.4645862,585,0.4513373,587,0.4516404,589,0.4033701,591,0.4466167,593,0.4513267,595,0.4524209,597,0.4613319,599,0.4546841,601,0.4499895,603,0.4631190,605,0.4724762,607,0.4724962,609,0.4569794,611,0.4599737,613,0.4363290,615,0.4488329,617,0.4267759,619,0.4545143,621,0.4514890,623,0.4384229,625,0.4256613,627,0.4470943,629,0.4565981,631,0.4458333,633,0.4533333,635,0.4546457,637,0.4535446,639,0.4638791,641,0.4561002,643,0.4617287,645,0.4594083,647,0.4597119,649,0.4517238,651,0.4686735,653,0.4686423,655,0.4544898,657,0.4255737,659,0.4640177,661,0.4711876,663,0.4679153,665,0.4689913,667,0.4592265,669,0.4668144,671,0.4498947,673,0.4629239,675,0.4559567,677,0.4596584,679,0.4549789,681,0.4586439,683,0.4653622,685,0.4543475,687,0.4632128,689,0.4711164,691,0.4709973,693,0.4685415,695,0.4696455,697,0.4769241,699,0.4760169,701,0.4701294,703,0.4815669,705,0.4850302,707,0.4707895,709,0.4570604,711,0.4465777,713,0.4382957,715,0.4379654,717,0.4446168,719,0.4350767,721,0.4466714,723,0.4579113,725,0.4625222,727,0.4669903,729,0.4615551,731,0.4763299,733,0.4793147,735,0.4857778,737,0.4997366,739,0.4915129,741,0.4926212,743,0.5062475,745,0.5072637,747,0.5170334,749,0.5173594,751,0.5244106,753,0.5344788,755,0.5397524,757,0.5387203,759,0.5280215,761,0.5191969,763,0.5085395,765,0.4984095,767,0.4749347,769,0.4878839,771,0.4798119,773,0.4821991,775,0.4799906,777,0.4870453,779,0.4928744,781,0.4934236,783,0.4904677,785,0.4849491,787,0.4947343,789,0.4890020,791,0.4789132,793,0.4822390,795,0.4795733,797,0.4973323,799,0.4988779,801,0.5054210,803,0.5087054,805,0.5103235,807,0.5187602,809,0.5151330,811,0.5223530,813,0.5396030,815,0.5475528,817,0.5543915,819,0.5380259,821,0.5321401,823,0.5366753,825,0.5372011,827,0.5440262,829,0.5390591,831,0.5212784,833,0.5187033,835,0.5197124,837,0.5241092,839,0.5070799,841,0.5253056,843,0.5003658,845,0.4896143,847,0.4910508,849,0.4964088,851,0.4753377,853,0.4986498,855,0.4604553,857,0.5174022,859,0.5105171,861,0.5175606,863,0.5322153,865,0.5335880,867,0.4811849,869,0.5241390,871,0.5458069,873,0.5508025,875,0.5423946,877,0.5580108,879,0.5677047,881,0.5580099,883,0.5649928,885,0.5629494,887,0.5384574,889,0.5523318,891,0.5614248,893,0.5521309,895,0.5550786,897,0.5583751,899,0.5597844,901,0.5394855,903,0.5638478,905,0.5862635,907,0.5877920,909,0.5774965,911,0.5866240,913,0.5989106,915,0.5958623,917,0.5964975,919,0.6041389,921,0.5797449,923,0.5607401,925,0.5640816,927,0.5704267,929,0.5642119,931,0.5694372,933,0.5716141,935,0.5705180,937,0.5618458,939,0.5736730,941,0.5630236,943,0.5796418,945,0.5720721,947,0.5873186,949,0.5896322,951,0.5794164,953,0.5828271,955,0.5692468,957,0.5808756,959,0.5949017,961,0.5875516,963,0.5923656,965,0.5824188,967,0.5838008,969,0.5948942,971,0.5865689,973,0.5818128,975,0.5807992,977,0.5851036,979,0.5775164,981,0.5938626,983,0.5885816,985,0.5943664,987,0.5911885,989,0.5916490,991,0.5868101,993,0.5919505,995,0.5945270,997,0.5960248,999,0.5950870,1003,0.5948938,1007,0.5888742,1013,0.6006343,1017,0.5958836,1022,0.6004154,1028,0.6050616,1032,0.5995678,1038,0.5984462,1043,0.6035475,1048,0.5973678,1052,0.5940806,1058,0.5854267,1063,0.5827191,1068,0.5788137,1072,0.5843356,1078,0.5830553,1082,0.5762549,1087,0.5766769,1092,0.5759526,1098,0.5726978,1102,0.5718654,1108,0.5658845,1113,0.5661672,1117,0.5637793,1122,0.5660178,1128,0.5608876,1133,0.5622964,1138,0.5603359,1143,0.5563605,1147,0.5652205,1153,0.5656560,1157,0.5607483,1162,0.5540304,1167,0.5556068,1173,0.5604768,1177,0.5492890,1183,0.5464411,1187,0.5385652,1192,0.5489344,1198,0.5331419,1203,0.5451093,1207,0.5419047,1212,0.5443417,1218,0.5477119,1223,0.5460783,1227,0.5435469,1232,0.5413216,1237,0.5419156,1243,0.5360791,1248,0.5363784,1253,0.5330056,1258,0.5330475,1262,0.5312735,1267,0.5282075,1272,0.5301258,1278,0.5318302,1283,0.5143390,1288,0.5259125,1292,0.5214670,1298,0.5287547,1302,0.5231621,1308,0.5267800,1313,0.5167545,1318,0.5170787,1323,0.5186867,1328,0.5111090,1332,0.5122823,1338,0.5085013,1343,0.5118057,1347,0.5086671,1352,0.5063367,1357,0.5007655,1363,0.5001648,1367,0.5036531,1373,0.5066053,1377,0.5064235,1382,0.5083958,1388,0.5053201,1393,0.4855558,1397,0.4835752,1402,0.4799809,1408,0.4854351,1412,0.4802711,1418,0.4867642,1423,0.4831264,1428,0.4768633,1433,0.4864127,1438,0.4916220,1442,0.4807589,1448,0.4908799,1452,0.4878666,1457,0.4919060,1462,0.4832121,1467,0.4817380,1472,0.4788120,1477,0.4832511,1483,0.4873623,1488,0.4833546,1492,0.4970729,1498,0.4941945,1503,0.4882672,1507,0.4906435,1512,0.5011545,1517,0.5042579,1522,0.5053326,1528,0.5103188,1533,0.5104235,1537,0.5109443,1543,0.5088747,1548,0.5114602,1552,0.5078479,1557,0.4955375,1562,0.5020681,1567,0.5009384,1572,0.5130484,1578,0.4843262,1583,0.4878957,1587,0.4869790,1593,0.5039261,1598,0.4961504,1605,0.5016433,1615,0.5109383,1625,0.5010374,1635,0.5166810,1645,0.4997573,1655,0.5132085,1665,0.5045445,1675,0.5038381,1685,0.4979366,1695,0.5024966,1705,0.4946397,1715,0.4900714,1725,0.4820987,1735,0.4704836,1745,0.4675962,1755,0.4610580,1765,0.4542064,1775,0.4442880,1785,0.4394009,1795,0.4305704,1805,0.4214249,1815,0.4154385,1825,0.4121445,1835,0.4087068,1845,0.4004347,1855,0.3981439,1865,0.3898276,1875,0.3819086,1885,0.3837946,1895,0.3719080,1905,0.3783857,1915,0.3734775,1925,0.3706359,1935,0.3625896,1945,0.3552610,1955,0.3559292,1965,0.3516581,1975,0.3442642,1985,0.3424439,1995,0.3401458,2005,0.3400624,2015,0.3370426,2025,0.3310865,2035,0.3294150,2045,0.3300824,2055,0.3263510,2065,0.3238343,2075,0.3226433,2085,0.3196882,2095,0.3156795,2105,0.3170735,2115,0.3129192,2125,0.3107151,2135,0.3111934,2145,0.3083829,2155,0.3053164,2165,0.3011248,2175,0.2987932,2185,0.2973707,2195,0.2953015,2205,0.2894185,2215,0.2910636,2225,0.2855524,2235,0.2835412,2245,0.2813240,2255,0.2794243,2265,0.2746838,2275,0.2752567,2285,0.2700351,2295,0.2315953,2305,0.2464873,2315,0.2460988,2325,0.2138361,2335,0.2290047,2345,0.2216595,2355,0.1997312,2365,0.2151513,2375,0.2079374,2385,0.1903472,2395,0.2020694,2405,0.1988067,2415,0.1834113,2425,0.1912983,2435,0.1873909,2445,0.1783537,2455,0.1759682,2465,0.1784857,2475,0.1715942,2485,0.1573562,2495,0.1568707,2505,0.1598265";

function curveToCSV(arr) {
  const parts = [];
  for (const p of arr) parts.push(p[0], p[1]);
  return parts.join(',');
}

const TARGET = 'M81_M82';
const SRC = '/Users/aescaffre/Bodes Galaxy/M81 M82';

// Known plate solution for M81/M82
const RA_DEG = 149.0500047826425;   // RA in degrees
const DEC_DEG = 69.32185996780197;  // Dec in degrees
const FOCAL_MM = 1484.1163;
const PIXEL_UM = 3.76;
const RESOLUTION_ARCSEC = 0.523;    // arcsec/px

async function main() {
  console.log('=== SPCC Test — Manual WCS + SPCC ===\n');

  // 1. Clean up
  console.log('1. Cleaning up...');
  let r = await pjsr(`
    var wins = ImageWindow.windows;
    var closed = 0;
    for (var i = wins.length - 1; i >= 0; i--) { wins[i].forceClose(); closed++; }
    'Closed ' + closed + ' images';
  `);
  console.log('  ', r.result);

  // 2. Open R, G, B and create RGB composite
  console.log('\n2. Opening masters and creating RGB...');
  r = await pjsr(`
    var R = ImageWindow.open('${SRC}/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-R_mono_autocrop.xisf')[0];
    var G = ImageWindow.open('${SRC}/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-V_mono_autocrop.xisf')[0];
    var B = ImageWindow.open('${SRC}/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-B_mono_autocrop.xisf')[0];
    R.mainView.id + '|' + G.mainView.id + '|' + B.mainView.id;
  `);
  console.log('   Opened:', r.result);
  if (r.status === 'error') { console.log('   ERROR:', r.error?.message); process.exit(1); }
  const [rId, gId, bId] = r.result.split('|');

  // Close crop masks
  r = await pjsr(`
    var wins = ImageWindow.windows; var closed = 0;
    for (var i = wins.length - 1; i >= 0; i--) {
      if (wins[i].mainView.id.indexOf('crop_mask') >= 0) { wins[i].forceClose(); closed++; }
    }
    'Closed ' + closed + ' crop masks';
  `);
  console.log('  ', r.result);

  // Create RGB via PixelMath
  r = await pjsr(`
    var R = ImageWindow.windowById('${rId}');
    var w = R.mainView.image.width;
    var h = R.mainView.image.height;
    var P = new PixelMath;
    P.expression='${rId}'; P.expression1='${gId}'; P.expression2='${bId}';
    P.useSingleExpression=false; P.createNewImage=true; P.showNewImage=true;
    P.newImageId='${TARGET}'; P.newImageWidth=w; P.newImageHeight=h;
    P.newImageColorSpace=PixelMath.prototype.RGB; P.newImageSampleFormat=PixelMath.prototype.f32;
    P.executeGlobal();
    '${TARGET}: ' + w + 'x' + h;
  `);
  console.log('   Created:', r.result);
  if (r.status === 'error') { console.log('   ERROR:', r.error?.message); process.exit(1); }

  // Close originals
  r = await pjsr(`
    var ids = ['${rId}', '${gId}', '${bId}'];
    for (var i = 0; i < ids.length; i++) {
      var w = ImageWindow.windowById(ids[i]);
      if (!w.isNull) w.forceClose();
    }
    'Closed originals';
  `);
  console.log('  ', r.result);

  // 4. Plate-solve RGB directly with ImageSolver (NOT copyAstrometricSolution)
  console.log('\n4. Plate-solving RGB composite with ImageSolver...');

  // First, copy observation keywords from R master (needed for plate solving)
  r = await pjsr(`
    var R = ImageWindow.open('${SRC}/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-R_mono_autocrop.xisf')[0];
    var d = ImageWindow.windowById('${TARGET}');

    // Copy important FITS keywords
    var rKW = R.keywords;
    var tKW = d.keywords;
    var copyNames = ['DATE-OBS', 'DATE-END', 'OBSGEO-L', 'OBSGEO-B', 'OBSGEO-H',
                     'LONG-OBS', 'LAT-OBS', 'ALT-OBS', 'EXPTIME', 'TELESCOP', 'INSTRUME', 'OBJECT',
                     'FOCALLEN', 'XPIXSZ', 'YPIXSZ', 'RA', 'DEC', 'OBJCTRA', 'OBJCTDEC'];
    var copied = [];
    for (var k = 0; k < copyNames.length; k++) {
      var name = copyNames[k];
      // Check if target already has this keyword
      var alreadyHas = false;
      for (var j = 0; j < tKW.length; j++) {
        if (tKW[j].name === name) { alreadyHas = true; break; }
      }
      if (!alreadyHas) {
        for (var i = 0; i < rKW.length; i++) {
          if (rKW[i].name === name) {
            tKW.push(new FITSKeyword(rKW[i].name, rKW[i].value, rKW[i].comment));
            copied.push(name);
            break;
          }
        }
      }
    }
    d.keywords = tKW;

    // Copy XISF observation properties
    var obsProps = [
      'Observation:Time:Start', 'Observation:Time:End',
      'Observation:Location:Longitude', 'Observation:Location:Latitude', 'Observation:Location:Elevation'
    ];
    for (var p = 0; p < obsProps.length; p++) {
      try {
        var v = R.mainView.propertyValue(obsProps[p]);
        var t = R.mainView.propertyType(obsProps[p]);
        if (v !== undefined && v !== null) d.mainView.setPropertyValue(obsProps[p], v, t);
      } catch(e) {}
    }

    // Close R and its crop masks
    var wins = ImageWindow.windows;
    for (var i = wins.length - 1; i >= 0; i--) {
      var vid = wins[i].mainView.id;
      if (vid.indexOf('crop_mask') >= 0 || vid === R.mainView.id) wins[i].forceClose();
    }
    'Copied keywords: ' + copied.join(', ');
  `);
  console.log('  ', r.result);

  // Now plate-solve with ImageSolver
  console.log('   Running ImageSolver on RGB...');
  r = await pjsr(`
    var w = ImageWindow.windowById('${TARGET}');
    w.show();

    var solver = new ImageSolver;
    solver.Init(w);

    // Set initial parameters from known values
    solver.metadata.ra = ${RA_DEG};
    solver.metadata.dec = ${DEC_DEG};
    solver.metadata.focal = ${FOCAL_MM};
    solver.metadata.xpixsz = ${PIXEL_UM};
    solver.metadata.resolution = ${RESOLUTION_ARCSEC} / 3600; // arcsec to degrees

    // Use Gaia DR3 catalog for plate solving
    solver.catalogName = "GaiaDR3";
    solver.vizierServer = "http://vizier.cds.unistra.fr";
    solver.autoMagnitude = true;
    solver.sensitivity = 0.5;
    solver.projectionOriginMode = 0; // center of image
    solver.distortionCorrection = false;
    solver.forceSolve = true;
    solver.showStars = false;
    solver.generateErrorImg = false;
    solver.showDistortion = false;

    solver.SolveImage(w);

    var info = 'hasAstro=' + w.hasAstrometricSolution;
    if (w.hasAstrometricSolution) {
      info += '\\n' + w.astrometricSolutionSummary().substring(0, 500);
    } else {
      info += ' PLATE SOLVE FAILED';
    }
    info;
  `);
  console.log('  ', r.result);
  if (r.status === 'error') { console.log('   ERROR:', r.error?.message); }

  // 6. Pre-SPCC medians
  console.log('\n6. Pre-SPCC medians...');
  r = await pjsr(`
    var img = ImageWindow.windowById('${TARGET}').mainView.image;
    img.selectedChannel=0; var mr=img.median();
    img.selectedChannel=1; var mg=img.median();
    img.selectedChannel=2; var mb=img.median();
    img.resetChannelSelection();
    'R=' + mr.toFixed(8) + ' G=' + mg.toFixed(8) + ' B=' + mb.toFixed(8);
  `);
  console.log('   Medians:', r.result);
  const preMedians = r.result;

  // 6b. Image statistics + StarDetector diagnostic
  console.log('\n6b. Image statistics...');
  r = await pjsr(`
    var w = ImageWindow.windowById('${TARGET}');
    var img = w.mainView.image;
    var info = '';
    for (var ch = 0; ch < 3; ch++) {
      img.selectedChannel = ch;
      var names = ['R', 'G', 'B'];
      info += names[ch] + ': min=' + img.minimum().toFixed(8) + ' max=' + img.maximum().toFixed(6);
      info += ' mean=' + img.mean().toFixed(8) + ' median=' + img.median().toFixed(8) + '\\n';
    }
    img.resetChannelSelection();
    info;
  `);
  console.log(r.result);

  // 6c. StarDetector format check
  console.log('6c. StarDetector format check...');
  r = await pjsr(`
    var w = ImageWindow.windowById('${TARGET}');
    var SD = new StarDetector;
    SD.structureLayers = 5;
    SD.sensitivity = 0.5;
    SD.peakResponse = 0.5;
    SD.minSNR = 10;
    var img = w.mainView.image;
    img.selectedChannel = 0;
    var stars = SD.stars(img);
    img.resetChannelSelection();
    var info = 'StarDetector found ' + stars.length + ' stars\\n';
    if (stars.length > 0) {
      var s0 = stars[0];
      info += 'Type of stars[0]: ' + typeof s0 + '\\n';
      info += 'Is Array: ' + (s0 instanceof Array) + '\\n';
      if (typeof s0 === 'object') {
        var keys = [];
        for (var k in s0) keys.push(k + '=' + typeof s0[k]);
        info += 'Keys: ' + keys.join(', ') + '\\n';
        info += 'Raw: ' + JSON.stringify(s0).substring(0, 200) + '\\n';
      }
    }
    info;
  `);
  console.log(r.result);
  if (r.status === 'error') console.log('   ERROR:', r.error?.message);

  // 6d. WCS mapping diagnostic with known bright stars
  console.log('6d. WCS mapping diagnostic...');
  r = await pjsr(`
    var w = ImageWindow.windowById('${TARGET}');
    var metadata = new ImageMetadata;
    metadata.ExtractMetadata(w);
    var info = 'WCS ref coords: RA=' + metadata.ra + ' Dec=' + metadata.dec + '\\n';
    info += 'Resolution: ' + (metadata.resolution ? metadata.resolution * 3600 : 'N/A') + ' arcsec/px\\n';
    info += 'Projection: ' + metadata.projection + '\\n';
    // Test known star positions (from Simbad/Gaia around M81 field)
    // HD 87737 (bright star near M81): RA=151.985, Dec=69.832
    // TYC 4383-729-1: RA=148.52, Dec=69.50
    var testStars = [
      {name: 'Field center', ra: 149.050, dec: 69.322},
      {name: 'NE corner approx', ra: 149.8, dec: 69.6},
      {name: 'SW corner approx', ra: 148.3, dec: 69.0}
    ];
    for (var i = 0; i < testStars.length; i++) {
      var ts = testStars[i];
      try {
        var imgPt = metadata.Convert_RD_I(new Point(ts.ra, ts.dec));
        info += ts.name + ': RA=' + ts.ra + ' Dec=' + ts.dec + ' -> img(' + imgPt.x.toFixed(1) + ',' + imgPt.y.toFixed(1) + ')';
        // Check if within image bounds
        var inBounds = imgPt.x >= 0 && imgPt.x < 5890 && imgPt.y >= 0 && imgPt.y < 3995;
        info += (inBounds ? ' [IN BOUNDS]' : ' [OUT OF BOUNDS]') + '\\n';
      } catch(e) {
        info += ts.name + ': ERROR ' + e.message + '\\n';
      }
    }
    info;
  `);
  console.log(r.result);
  if (r.status === 'error') console.log('   ERROR:', r.error?.message);

  // 7. Run SPCC with custom curves + console.beginLog()
  console.log('\n7. SPCC with custom curves + console.beginLog()...');
  const spccData = {
    whiteRef: WHITE_REF_AVG_SPIRAL,
    red: curveToCSV(ASTRONOMIK_R),
    green: curveToCSV(ASTRONOMIK_G),
    blue: curveToCSV(ASTRONOMIK_B),
    qe: curveToCSV(SONY_IMX411_QE)
  };
  fs.writeFileSync('/tmp/spcc-curves.json', JSON.stringify(spccData));

  r = await pjsr(`
    // Close any existing SPCC output windows
    var spccW = ImageWindow.windowById('SPCC_stars');
    if (!spccW.isNull) spccW.forceClose();

    var logFile = '/tmp/spcc-custom-log.txt';
    console.show();
    console.abortEnabled = false;
    console.beginLog(logFile);
    console.writeln('=== SPCC CUSTOM CURVES TEST ===');

    var w = ImageWindow.windowById('${TARGET}');
    var json = File.readLines('/tmp/spcc-curves.json').join('');
    var c = JSON.parse(json);

    var P = new SpectrophotometricColorCalibration;
    P.applyCalibration = true;
    P.narrowbandMode = false;
    P.whiteReferenceSpectrum = c.whiteRef;
    P.whiteReferenceName = 'Average Spiral Galaxy';
    P.redFilterTrCurve = c.red;
    P.redFilterName = 'Astronomik Deep Sky R';
    P.greenFilterTrCurve = c.green;
    P.greenFilterName = 'Astronomik Deep Sky G';
    P.blueFilterTrCurve = c.blue;
    P.blueFilterName = 'Astronomik Deep Sky B';
    P.deviceQECurve = c.qe;
    P.deviceQECurveName = 'Sony IMX411/455/461/533/571';
    P.neutralizeBackground = true;
    P.backgroundLow = -2.80;
    P.backgroundHigh = 2.00;
    P.catalogId = 'GaiaDR3SP';
    P.autoLimitMagnitude = true;
    P.limitMagnitude = 14.00;
    P.targetSourceCount = 2000;
    P.psfStructureLayers = 5;
    P.saturationThreshold = 0.75;
    P.saturationRelative = true;
    P.saturationShrinkFactor = 0.10;
    P.psfMinSNR = 5.00;  // lowered from 10
    P.psfAllowClusteredSources = true;
    P.psfType = SpectrophotometricColorCalibration.prototype.PSFType_Auto;
    P.psfGrowth = 1.25;
    P.psfMaxStars = 24576;
    P.psfSearchTolerance = 8.00;  // doubled from 4
    P.psfChannelSearchTolerance = 4.00;  // doubled from 2
    P.generateGraphs = true;
    P.generateStarMaps = true;
    P.generateTextFiles = true;

    console.writeln('Running SPCC with custom Astronomik curves...');
    var ret = P.executeOn(w.mainView);
    console.writeln('Result: ' + ret);

    console.writeln('=== END ===');
    console.endLog();
    console.abortEnabled = true;

    var lines = File.readLines(logFile);
    lines.join('\\n');
  `);
  console.log('   SPCC custom curves log:');
  console.log(r.result);
  if (r.status === 'error') console.log('   ERROR:', r.error?.message);

  // 8. Post-SPCC medians
  console.log('\n8. Post-SPCC medians...');
  r = await pjsr(`
    var img = ImageWindow.windowById('${TARGET}').mainView.image;
    img.selectedChannel=0; var mr=img.median();
    img.selectedChannel=1; var mg=img.median();
    img.selectedChannel=2; var mb=img.median();
    img.resetChannelSelection();
    'R=' + mr.toFixed(8) + ' G=' + mg.toFixed(8) + ' B=' + mb.toFixed(8);
  `);
  console.log('   Medians:', r.result);

  // Compare
  console.log('\n=== COMPARISON ===');
  console.log('   Pre:  ', preMedians);
  console.log('   Post: ', r.result);
  if (preMedians === r.result) {
    console.log('   RESULT: SPCC HAD NO EFFECT (medians identical)');
  } else {
    console.log('   RESULT: SPCC CHANGED MEDIANS! Color calibration is working!');
  }

  // 9. Cleanup
  console.log('\n9. Cleanup...');
  r = await pjsr(`
    var wins = ImageWindow.windows;
    var closed = 0;
    for (var i = wins.length - 1; i >= 0; i--) { wins[i].forceClose(); closed++; }
    'Closed ' + closed + ' images';
  `);
  console.log('  ', r.result);

  console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
