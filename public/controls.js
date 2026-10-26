// Presentation hints only. OSC addresses and values are never renamed or remapped.
export const categories = ['All', 'Props & toys', 'Expressions', 'Body & effects', 'Outfit', 'Colors', 'Other'];
const systemRoot = /^(?:Go|FT|FTCopy|VRCFT|OSCm|OGB|VFH|State|Smoothing|Cam|Contacts)(?:\/|$)/i;
const sensor = /(?:tracking|proxy|sync|raycast|rigidbody|collision|(?:^|[/_ ])debug|(?:^|[/_ ])version|bit\d|contact$|(?:^|\/)contacts\/|(?:^|\/)_[^/]*|groundAngle|groundSmoothing|grounded|DetectMirror|IsMirror|RemoteModeActive|Visemes|FacialExpressionsDisabled|EyeDilationEnable|LipTrackingActive|EyeTrackingActive|FaceTracking|_tracking|CgeSmiling|^VF[\s\d]|^mesh$)/i;
const propFeatures = /\/(?:Scanner|AngleGrinder|Baton|CD|USBKiller|MenuScan|RigRadial|MenuMode|Menu|RigOn|WearEnabled|ManualLoad|SpinSpeed|GrinderEnable|Extend|MenuThrow|MenuGrab|Reset|GestureControl|Drop|SwitchPosition|Explosion|Scale)$/i;
const labels = {
  'Clothes/Top_Hoodie': 'Hoodie', 'Clothes/All_Off': 'Remove outfit',
  'Clothes/T': 'T-shirt', 'Clothes/Short': 'Shorts', 'Clothes/Top': 'Top',
  'Clothes/Warmers 2': 'Leg warmers · Style 2', 'Clothes/SockType': 'Sock style',
  'Clothes/ShortsLiner': 'Shorts liner', 'Clothes/ShortsCarabiner': 'Shorts carabiner',
  'Avatar/Tail_IDL': 'Tail idle animation', 'Avatar/Ears_IDL': 'Ear idle animation',
  'Avatar/Head/BoopOff': 'Disable head boop', 'Avatar/Audio Link': 'Audio-reactive effects',
  'Avatar/HUE': 'Avatar color hue', 'Avatar/Color H E T': 'Hair, ears & tail color',
  'Avatar/Claw_Foot': 'Foot claw style', 'Avatar/Claw': 'Hand claw style',
  'Avatar/Finger_Thin': 'Slim fingers', 'Accessories/HUE': 'Accessory color hue',
  'Accessories/Acce Ears': 'Ear accessories', 'Accessories/Acce Tail': 'Tail accessories',
  'Body/Catmode': 'Cat mode', 'Body/BlinkEnable': 'Auto blink',
  'Body/ManualMMD': 'MMD animation mode', 'Body/HeadContactsEnable': 'Head touch reactions',
  'Body/FistFaceEnable': 'Fist face reactions', 'Body/FaceExpressions': 'Face expression',
  'Body/FreezeFace': 'Freeze facial expression', 'VRCEmote': 'Emote slot', 'Go/VRCEmote': 'Emote slot',
  'Color/Outfit': 'Outfit color', 'Color/Eyes': 'Eye color', 'Color/Hair': 'Hair color',
  'Other/Boop SFX': 'Boop sound', 'Other/Crop_Top-Top Belly': 'Crop top length',
  'Props/AngleGrinder/GrinderEnable': 'Angle grinder power', 'Props/AngleGrinder/SpinSpeed': 'Grinder spin speed',
  'Props/AngleGrinder/WearEnabled': 'Grinder wheel wear', 'Props/AngleGrinder/ManualLoad': 'Manual wheel loading',
  'Props/Scanner/MenuScan': 'Scanner · Scan', 'Props/Scanner/MenuMode': 'Scanner · Scan mode',
  'Props/Scanner/RigRadial': 'Scanner · Rig value', 'Props/Scanner/RigOn': 'Scanner · Rig result',
  'Props/CD/MenuThrow': 'Throw CD', 'Props/CD/MenuGrab': 'Grab CD', 'Props/CD/Reset': 'Reset CD',
  'Props/USBKiller/Scale': 'USB killer size', 'Props/USBKiller/GestureControl': 'USB killer gestures',
  'Props/USBKiller/Drop': 'Drop USB killer',
};

export function humanize(value) {
  return value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ').replace(/\bAcce\b/gi, 'Accessories').replace(/\bEms\b/gi, 'Glow')
    .replace(/\bSat\b/gi, 'Saturation').replace(/\bIDL\b/gi, 'Idle animation').replace(/\s+/g, ' ').trim()
    .replace(/^./, letter => letter.toUpperCase());
}

function groupFor(name) {
  if (/^(Props|Toys|Gimmicks)\//i.test(name) || /(?:Karambit|Bear|Plushie)/i.test(name)) return 'Props & toys';
  if (/Emote|Expression|Gesture|FreezeFace|SimpleBlink|Cge/i.test(name)) return 'Expressions';
  if (/^(Color)\/|Hue|Color|Saturation|\bSat\b|RGB|Greyscale|Metallic|Tattoo|Tatts|Black Tips/i.test(name)) return 'Colors';
  if (/^(Clothes|Accessories)\//i.test(name) || /(?:Jacket|Sweater|Skirt|Shorts?|Shoes|Sneaker|Socks?|Boots|Fishnet|Corset|Scarf|Belt|Hoodie|Bandage|Piercing|Headband|Gloves|Shirt|Top|Bottom|Harness|Thigh High|Leggin|Headband|Rings|Bangs|Chain)/i.test(name)) return 'Outfit';
  if (/^(Body|Avatar|Other)\/|Tail|Ear|Halo|Sparks|Boop|Headpat|BringMeToLife|Limb/i.test(name)) return 'Body & effects';
  return 'Other';
}

export function describeControls(parameters = []) {
  const normalize = name => name.replace(/^(?:VF\d+_)+/i, '');
  const priority = p => p.name.length - normalize(p.name).length;
  const preferred = new Map();
  for (const parameter of parameters) {
    const key = normalize(parameter.name).toLowerCase(), previous = preferred.get(key);
    if (!previous || priority(parameter) < priority(previous)) preferred.set(key, parameter);
  }
  const canonical = new Set(parameters.filter(p => !/^VF\d+_/i.test(p.name)).map(p => p.name.toLowerCase()));
  return parameters.map(parameter => {
    const name = normalize(parameter.name);
    const generated = name !== parameter.name;
    const duplicate = preferred.get(name.toLowerCase()) !== parameter;
    const emote = /^(?:Go\/)?VRCEmote$/i.test(name);
    const usefulGenerated = (/^(Props|Toys|Gimmicks)\//i.test(name) && propFeatures.test(name)) || /^(Clothes|Accessories|Avatar|Color|Body|Other)\//i.test(name);
    const internal = duplicate || (!emote && (systemRoot.test(name) || sensor.test(name) || name.startsWith('_') ||
      (generated && !usefulGenerated))) || (name === 'Go/VRCEmote' && canonical.has('vrcemote'));
    const parts = name.split('/');
    let label = labels[name];
    if (!label) {
      if (/^(Props|Toys|Gimmicks)$/i.test(parts[0]) && parts.length >= 3) {
        const prop = humanize(parts[1]), feature = humanize(parts.slice(2).join(' · '));
        label = parts[1].toLowerCase() === parts.at(-1).toLowerCase() ? prop : `${prop} · ${feature.replace(/^Menu /, '')}`;
      } else label = parts.slice(1).length ? humanize(parts.slice(1).join(' · ')) : humanize(name);
    }
    return { ...parameter, label, category: internal ? 'Internal' : groupFor(name), internal, normalizedName: name };
  });
}

export function formatFeedback(value) {
  if (value === undefined) return 'Waiting for feedback';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return Number(value.toFixed(3)).toString();
  return String(value);
}

export function integerSliderRange(parameter, observed) {
  // Expression ints normally use 0–255; the built-in emote alias has 16 slots.
  const emote = /(?:^|\/)VRCEmote$/i.test(parameter.normalizedName || parameter.name);
  const current = Number.isInteger(observed) ? observed : 0;
  return { min: Math.min(0, current), max: Math.max(emote ? 16 : 255, current), value: current };
}
