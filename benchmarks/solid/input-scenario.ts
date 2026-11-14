export function inputScenario(inputLatency: boolean, visibleInput: boolean, calibration: boolean) {
  if ((inputLatency && visibleInput) || (calibration && (inputLatency || visibleInput)))
    throw new Error('Input latency, visible input and calibration are separate launches')
  return inputLatency ? 'input-latency' : visibleInput ? 'visible-input' : null
}
