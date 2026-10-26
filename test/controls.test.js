import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeControls, formatFeedback, integerSliderRange } from '../public/controls.js';

const parameter = name => ({ name, address: `/avatar/parameters/${name}`, type: 'Bool' });

test('integer sliders use expression and emote ranges while preserving observed outliers', () => {
  assert.deepEqual(integerSliderRange(parameter('Clothes/Style')), { min: 0, max: 255, value: 0 });
  assert.deepEqual(integerSliderRange(parameter('Go/VRCEmote'), 3), { min: 0, max: 16, value: 3 });
  assert.deepEqual(integerSliderRange({ ...parameter('VF99_Go/VRCEmote'), normalizedName: 'Go/VRCEmote' }, 0), { min: 0, max: 16, value: 0 });
  assert.deepEqual(integerSliderRange(parameter('Local/Int'), -12), { min: -12, max: 255, value: -12 });
  assert.deepEqual(integerSliderRange(parameter('Local/Int'), 400), { min: 0, max: 400, value: 400 });
});

test('stream view hides tracking, sensors, binary sync and duplicate generated aliases', () => {
  const parameters = [
    parameter('OSCm/Binary/VRCFT/v2/JawOpen16'), parameter('VRCFT/v2/JawOpen'),
    parameter('VF34_TC_current_trackingMouth'), parameter('Body/PatContact'),
    parameter('VF 2022.3.22f1'), parameter('OGB/Orf/Test/TouchOthers'),
    parameter('Clothes/Top_Hoodie'), parameter('VF57_Clothes/Top_Hoodie'),
    parameter('Avatar/Tail'), parameter('Avatar/Tail_IDL'),
  ];
  const controls = describeControls(parameters);
  assert.deepEqual(controls.filter(p => !p.internal).map(p => p.name), ['Clothes/Top_Hoodie', 'Avatar/Tail', 'Avatar/Tail_IDL']);
  assert.equal(controls.find(p => p.name === 'Clothes/Top_Hoodie').label, 'Hoodie');
  assert.equal(controls.find(p => p.name === 'Avatar/Tail_IDL').label, 'Tail idle animation');
  assert.equal(controls.find(p => p.name === 'Avatar/Tail').address, '/avatar/parameters/Avatar/Tail', 'labels must not rewrite OSC addresses');
});

test('useful generated prop controls survive filtering, with a single preferred alias', () => {
  const controls = describeControls([
    parameter('VF57_VF144_Props/Scanner/Scanner'), parameter('VF144_Props/Scanner/Scanner'),
    parameter('VF144_Props/Scanner/MenuScan'), parameter('VF144_Props/Scanner/ScreenModeBit1'),
    parameter('VF137_Props/AngleGrinder/Raycast_Distance'), parameter('VF137_Props/AngleGrinder/SpinSpeed'),
    parameter('Go/VRCEmote'), parameter('Go/TrackingTypeProxy'),
  ]);
  assert.deepEqual(controls.filter(p => !p.internal).map(p => p.label), ['Scanner', 'Scanner · Scan', 'Grinder spin speed', 'Emote slot']);
  assert.equal(controls.find(p => p.label === 'Grinder spin speed').category, 'Props & toys');
});

test('colors and outfits have readable groups; feedback does not expose long floating point noise', () => {
  const controls = describeControls([parameter('Clothes/Color'), parameter('Accessories/GlovesRight')]);
  assert.equal(controls[0].category, 'Colors'); assert.equal(controls[1].label, 'Gloves Right');
  assert.equal(formatFeedback(0.12345678), '0.123'); assert.equal(formatFeedback(true), 'On');
  assert.equal(formatFeedback(undefined), 'Waiting for feedback');
  const generatedOutfit = describeControls([parameter('VF99_Clothes/Jacket')])[0];
  assert.equal(generatedOutfit.internal, false, 'a generated name alone must not hide the only useful outfit control');
  assert.equal(generatedOutfit.label, 'Jacket');
});
