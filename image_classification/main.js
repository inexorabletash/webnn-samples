'use strict';

import {ResNet50V1FP16Nchw} from './resnet50v1_fp16_nchw.js';
import {EfficientNetFP16Nchw} from './efficientnet_fp16_nchw.js';
import {MobileNetV2Nchw} from './mobilenet_nchw.js';
import {MobileNetV2Nhwc} from './mobilenet_nhwc.js';
import {SqueezeNetNchw} from './squeezenet_nchw.js';
import {SqueezeNetNhwc} from './squeezenet_nhwc.js';
import {ResNet50V2Nchw} from './resnet50v2_nchw.js';
import {ResNet50V2Nhwc} from './resnet50v2_nhwc.js';
import * as ui from '../common/ui.js';
import * as utils from '../common/utils.js';

const maxWidth = 380;
const maxHeight = 380;
const imgElement = document.getElementById('feedElement');
imgElement.src = './images/test.jpg';
const camElement = document.getElementById('feedMediaElement');
let modelName = '';
let modelId = '';
let layout = 'nhwc';
let dataType = 'float32';
let instanceType = modelName + layout;
let rafReq;
let isFirstTimeLoad = true;
let inputType = 'image';
let netInstance = null;
let labels = null;
let stream = null;
let loadTime = 0;
let buildTime = 0;
let computeTime = 0;
let inputOptions;
let outputBuffer;
let deviceType = '';
let lastdeviceType = '';
let backend = '';
let lastBackend = '';
let stopRender = true;
let isRendering = false;
const disabledSelectors = ['#tabs > li', '.btn'];
const modelIds = [
  'mobilenet',
  'squeezenet',
  'resnet50',
  'resnet50v1',
  'efficientnet',
];
const modelList = {
  'cpu': {
    'float32': [
      'mobilenet',
      'squeezenet',
      'resnet50',
    ],
  },
  'gpu': {
    'float32': [
      'mobilenet',
      'squeezenet',
      'resnet50',
    ],
    'float16': [
      'efficientnet',
      'mobilenet',
      'resnet50v1',
    ],
  },
  'npu': {
    'float16': [
      'efficientnet',
      'mobilenet',
      'resnet50v1',
    ],
  },
};

async function fetchLabels(url) {
  const response = await fetch(url);
  const data = await response.text();
  return data.split('\n');
}

function displayAvailableModels(modelList, deviceType, dataType) {
  let models = [];
  if (dataType == '') {
    models = models.concat(modelList[deviceType]['float32']);
    models = models.concat(modelList[deviceType]['float16']);
  } else {
    models = models.concat(modelList[deviceType][dataType]);
  }
  // Remove duplicate ids.
  models = [...new Set(models)];
  // Display available models.
  for (const model of modelIds) {
    if (models.includes(model)) {
      $(`#${model}`).parent().show();
    } else {
      $(`#${model}`).parent().hide();
    }
  }
}

$(document).ready(async () => {
  $('.icdisplay').hide();
  if (await utils.isWebNN()) {
    $('#webnn_cpu').click();
  } else {
    $('#polyfill_cpu').click();
  }
});

$('#backendBtns .btn').on('change', async (e) => {
  if (inputType === 'camera') {
    await stopCamRender();
  }
  layout = utils.getDefaultLayout($(e.target).attr('id'));
  [backend, deviceType] = $(e.target).attr('id').split('_');
  // Only show the supported models for each deviceType. Now fp16 nchw models
  // are only supported on gpu/npu.
  if (deviceType == 'gpu') {
    ui.handleBtnUI('#float16Label', false);
    ui.handleBtnUI('#float32Label', false);
    displayAvailableModels(modelList, deviceType, dataType);
  } else if (deviceType == 'npu') {
    ui.handleBtnUI('#float16Label', false);
    ui.handleBtnUI('#float32Label', true);
    displayAvailableModels(modelList, deviceType, 'float16');
  } else {
    ui.handleBtnUI('#float16Label', true);
    ui.handleBtnUI('#float32Label', false);
    displayAvailableModels(modelList, deviceType, 'float32');
  }

  // Uncheck selected model
  if (modelId != '') {
    $(`#${modelId}`).parent().removeClass('active');
  }
});

$('#modelBtns .btn').on('change', async (e) => {
  if (inputType === 'camera') {
    await stopCamRender();
  }
  modelId = $(e.target).attr('id');
  modelName = modelId;
  if (dataType == 'float16') {
    modelName += 'fp16';
  }

  await main();
});

// $('#layoutBtns .btn').on('change', async (e) => {
//   if (inputType === 'camera') {
//     await stopCamRender();
//   }
//   layout = $(e.target).attr('id');
//   await main();
// });

$('#dataTypeBtns .btn').on('change', async (e) => {
  dataType = $(e.target).attr('id');
  displayAvailableModels(modelList, deviceType, dataType);
  // Uncheck selected model
  if (modelId != '') {
    $(`#${modelId}`).parent().removeClass('active');
  }
});


// Click trigger to do inference with <img> element
$('#img').click(async () => {
  if (inputType === 'camera') {
    await stopCamRender();
  } else {
    return;
  }
  inputType = 'image';
  $('.shoulddisplay').hide();
  await main();
});

$('#imageFile').change((e) => {
  const files = e.target.files;
  if (files.length > 0) {
    $('#feedElement').removeAttr('height');
    $('#feedElement').removeAttr('width');
    imgElement.src = URL.createObjectURL(files[0]);
  }
});

$('#feedElement').on('load', async () => {
  await main();
});

// Click trigger to do inference with <video> media element
$('#cam').click(async () => {
  if (inputType == 'camera') return;
  inputType = 'camera';
  $('.shoulddisplay').hide();
  await main();
});

function stopCamRender() {
  stopRender = true;
  utils.stopCameraStream(rafReq, stream);
  return new Promise((resolve) => {
    // if the rendering is not stopped, check it every 100ms
    setInterval(() => {
      // resolve when the rendering is stopped
      if (!isRendering) {
        resolve();
      }
    }, 100);
  });
}

/**
 * This method is used to render live camera tab.
 */
async function renderCamStream() {
  if (!stream.active || stopRender) return;
  // If the video element's readyState is 0, the video's width and height are 0.
  // So check the readState here to make sure it is greater than 0.
  if (camElement.readyState === 0) {
    rafReq = requestAnimationFrame(renderCamStream);
    return;
  }
  isRendering = true;
  const inputBuffer = utils.getInputTensor(camElement, inputOptions);
  const inputCanvas = utils.getVideoFrame(camElement);
  console.log('- Computing... ');
  const start = performance.now();
  const results = await netInstance.compute(inputBuffer, outputBuffer);
  computeTime = (performance.now() - start).toFixed(2);
  outputBuffer = results.outputs.output;
  console.log(`  done in ${computeTime} ms.`);
  drawInput(inputCanvas, 'camInCanvas');
  showPerfResult();
  await drawOutput(outputBuffer, labels);
  $('#fps').text(`${(1000/computeTime).toFixed(0)} FPS`);
  isRendering = false;
  if (!stopRender) {
    rafReq = requestAnimationFrame(renderCamStream);
  }
}

// Get top 3 classes of labels from output buffer
function getTopClasses(buffer, labels) {
  let float32Buffer = buffer;
  // Currently we need to fallback softmax to tf.softmax because
  // NPU dosen't support softmax.
  // Convert output buffer from float16 to float32, because
  // tf.tensor/tf.softmax doesn't support float16 data type
  // according to https://js.tensorflow.org/api/latest/#tensor.
  // TODO: Remove this workaround once NPU supports softmax.
  if (inputOptions.dataType === 'float16') {
    const elementsCount = utils.sizeOfShape(netInstance.outputDimensions);
    const float32Array = new Float32Array(elementsCount);
    for (let i = 0; i < elementsCount; ++i) {
      float32Array[i] = utils.float16ToNumber(buffer[i]);
    }
    float32Buffer = float32Array;

    // Softmax
    float32Buffer = tf.tidy(() => {
      const a =
        tf.tensor(float32Buffer, netInstance.outputDimensions, 'float32');
      const b = tf.softmax(a);
      return b.dataSync();
    });
  }

  const probs = Array.from(float32Buffer);
  const indexes = probs.map((prob, index) => [prob, index]);
  const sorted = indexes.sort((a, b) => {
    if (a[0] === b[0]) {
      return 0;
    }
    return a[0] < b[0] ? -1 : 1;
  });
  sorted.reverse();
  const classes = [];

  for (let i = 0; i < 3; ++i) {
    const prob = sorted[i][0];
    const index = sorted[i][1];
    const c = {
      label: labels[index],
      prob: (prob * 100).toFixed(2),
    };
    classes.push(c);
  }

  return classes;
}

function drawInput(srcElement, canvasId) {
  const inputCanvas = document.getElementById(canvasId);
  const resizeRatio = Math.max(
      Math.max(srcElement.width / maxWidth, srcElement.height / maxHeight), 1);
  const scaledWidth = Math.floor(srcElement.width / resizeRatio);
  const scaledHeight = Math.floor(srcElement.height / resizeRatio);
  inputCanvas.height = scaledHeight;
  inputCanvas.width = scaledWidth;
  const ctx = inputCanvas.getContext('2d');
  ctx.drawImage(srcElement, 0, 0, scaledWidth, scaledHeight);
}

async function drawOutput(outputBuffer, labels) {
  const labelClasses = getTopClasses(outputBuffer, labels);

  $('#inferenceresult').show();
  labelClasses.forEach((c, i) => {
    const labelElement = document.getElementById(`label${i}`);
    const probElement = document.getElementById(`prob${i}`);
    labelElement.innerHTML = `${c.label}`;
    probElement.innerHTML = `${c.prob}%`;
  });
}

function showPerfResult(medianComputeTime = undefined) {
  $('#loadTime').html(`${loadTime} ms`);
  $('#buildTime').html(`${buildTime} ms`);
  if (medianComputeTime !== undefined) {
    $('#computeLabel').html('Median inference time:');
    $('#computeTime').html(`${medianComputeTime} ms`);
  } else {
    $('#computeLabel').html('Inference time:');
    $('#computeTime').html(`${computeTime} ms`);
  }
}

function constructNetObject(type) {
  const netObject = {
    'mobilenetfp16nchw': new MobileNetV2Nchw('float16'),
    'resnet50v1fp16nchw': new ResNet50V1FP16Nchw(),
    'efficientnetfp16nchw': new EfficientNetFP16Nchw(),
    'mobilenetnchw': new MobileNetV2Nchw(),
    'mobilenetnhwc': new MobileNetV2Nhwc(),
    'squeezenetnchw': new SqueezeNetNchw(),
    'squeezenetnhwc': new SqueezeNetNhwc(),
    'resnet50nchw': new ResNet50V2Nchw(),
    'resnet50nhwc': new ResNet50V2Nhwc(),
  };

  return netObject[type];
}

async function main() {
  try {
    if (modelName === '') return;
    ui.handleClick(disabledSelectors, true);
    if (isFirstTimeLoad) $('#hint').hide();
    let start;
    const [numRuns, powerPreference, numThreads] = utils.getUrlParams();

    // Only do load() and build() when model first time loads,
    // there's new model choosed, backend changed or device changed
    if (isFirstTimeLoad || instanceType !== modelName + layout ||
        lastdeviceType != deviceType || lastBackend != backend) {
      if (lastdeviceType != deviceType || lastBackend != backend) {
        // Set backend and device
        await utils.setBackend(backend, deviceType);
        lastdeviceType = lastdeviceType != deviceType ?
            deviceType : lastdeviceType;
        lastBackend = lastBackend != backend ? backend : lastBackend;
      }
      if (netInstance !== null) {
        // Call dispose() to and avoid memory leak
        netInstance.dispose();
      }
      instanceType = modelName + layout;
      netInstance = constructNetObject(instanceType);
      inputOptions = netInstance.inputOptions;
      labels = await fetchLabels(inputOptions.labelUrl);
      if (inputOptions.dataType === 'float16') {
        outputBuffer =
          new Uint16Array(utils.sizeOfShape(netInstance.outputDimensions));
      } else {
        outputBuffer =
          new Float32Array(utils.sizeOfShape(netInstance.outputDimensions));
      }

      isFirstTimeLoad = false;
      console.log(`- Model name: ${modelName}, Model layout: ${layout} -`);
      // UI shows model loading progress
      await ui.showProgressComponent('current', 'pending', 'pending');
      console.log('- Loading weights... ');
      const contextOptions = {deviceType};
      if (powerPreference) {
        contextOptions['powerPreference'] = powerPreference;
      }
      if (numThreads) {
        contextOptions['numThreads'] = numThreads;
      }
      start = performance.now();
      const outputOperand = await netInstance.load(contextOptions);
      loadTime = (performance.now() - start).toFixed(2);
      console.log(`  done in ${loadTime} ms.`);
      // UI shows model building progress
      await ui.showProgressComponent('done', 'current', 'pending');
      console.log('- Building... ');
      start = performance.now();
      await netInstance.build(outputOperand);
      buildTime = (performance.now() - start).toFixed(2);
      console.log(`  done in ${buildTime} ms.`);
    }
    // UI shows inferencing progress
    await ui.showProgressComponent('done', 'done', 'current');
    if (inputType === 'image') {
      const inputBuffer = utils.getInputTensor(imgElement, inputOptions);
      console.log('- Computing... ');
      const computeTimeArray = [];
      let medianComputeTime;

      // Do warm up
      let results = await netInstance.compute(inputBuffer, outputBuffer);

      for (let i = 0; i < numRuns; i++) {
        start = performance.now();
        results = await netInstance.compute(
            results.inputs.input, results.outputs.output);
        computeTime = (performance.now() - start).toFixed(2);
        console.log(`  compute time ${i+1}: ${computeTime} ms`);
        computeTimeArray.push(Number(computeTime));
      }
      if (numRuns > 1) {
        medianComputeTime = utils.getMedianValue(computeTimeArray);
        medianComputeTime = medianComputeTime.toFixed(2);
        console.log(`  median compute time: ${medianComputeTime} ms`);
      }
      outputBuffer = results.outputs.output;
      console.log('outputBuffer: ', outputBuffer);
      await ui.showProgressComponent('done', 'done', 'done');
      ui.readyShowResultComponents();
      drawInput(imgElement, 'inputCanvas');
      await drawOutput(outputBuffer, labels);
      showPerfResult(medianComputeTime);
    } else if (inputType === 'camera') {
      stream = await utils.getMediaStream();
      camElement.srcObject = stream;
      stopRender = false;
      camElement.onloadeddata = await renderCamStream();
      await ui.showProgressComponent('done', 'done', 'done');
      ui.readyShowResultComponents();
    } else {
      throw Error(`Unknown inputType ${inputType}`);
    }
  } catch (error) {
    console.log(error);
    ui.addAlert(error.message);
  }
  ui.handleClick(disabledSelectors, false);
}
