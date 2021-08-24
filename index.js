const Influx = require('influx')
const nodeplotlib = require('nodeplotlib')
const fetch = require('node-fetch')
const fs = require('fs')

const plot = nodeplotlib.plot
const Plot = nodeplotlib.Plot

const northDbFilePath = './fileDB/northPVForecast.json'
const eastDbFilePath = './fileDB/eastPVForecast.json'
const northPVResourceID = process.env.PV1_RESOURCE_ID
const eastPVResourceID = process.env.PV2_RESOURCE_ID
const solcastApiKey = process.env.SOLCAST_API_KEY

const northPVForecastURL = new URL(`https://api.solcast.com.au/rooftop_sites/${northPVResourceID}/forecasts?format=json&api_key=${solcastApiKey}`)
const eastPVForecastURL = new URL(`https://api.solcast.com.au/rooftop_sites/${eastPVResourceID}/forecasts?format=json&api_key=${solcastApiKey}`)

const timeBetweenUpdates = 60*60*1000 // one hour

const batteryKWh = 5*3550/1000
const spareKWh = batteryKWh*0.15
const inverterEfficiency = 0.85 // This can later be replaced with a curve of load vs efficiency
const inverterChargeEfficiency = 0.9

const consumptionConfig = {
  baseLoadNight: {
    load: 300,
    startTime: 18,
    duration: 14
  },
  baseLoadDay: {
    load: 200,
    startTime: 8,
    duration: 10
  },
  pc: {
    load: 120,
    startTime: 0,
    duration: 24
  },
  pcScreen: {
    load: 60,
    startTime: 7,
    duration: 16,
  },
  tv: {
    load: 150,
    startTime: 0,
    duration: 24
  },
  gpuMiner: {
    load: 500+50 // include the cpu miner here for now
  },
  washingMachine1: {
    load: 1500,
    startTime: 9,
    duration: 0.5
  },
  washingMachine2: {
    load: 200,
    startTime: 9.5,
    duration: 2
  },
  breakfast:{
    load: 1000,
    startTime: 6.5,
    duration: 2 
  },
  dinner: {
    load: 1000,
    startTime: 17.5,
    duration: 2.5
  },
  lunch: {
    load: 800,
    startTime: 11.5,
    duration: 2
  }
}

const influx = new Influx.InfluxDB({
  host: '192.168.88.37',
  port: 8086,
  database: 'home_assistant'
})

async function getLastStateOfCharge(){

  // Only inverter 1 has the correct state of charge since only it is plugged in to the BMS of the pylontech
  const result1 = await influx.query(`
    SELECT LAST("value") FROM "%"
    WHERE ("entity_id" = 'voltronic_battery_capacity')
  `)

  const inverter1 = result1[0].last
  return inverter1
}

async function updateFileDB(url, dbFilePath){
 
  let fileObj
  try{
    const forecastRes = await fetch(url)
    const forecastObj = await forecastRes.json()
    forecastObj.timestamp = new Date().getTime()

    fs.writeFileSync(dbFilePath, JSON.stringify(forecastObj))

    const fileContents = fs.readFileSync(dbFilePath).toString()
    fileObj = JSON.parse(fileContents)
  } catch(error){
    console.log({error})
  }
  return fileObj
}

async function forecastPVPowerProduction(fileObj){

  let sum = 0
  const timeArray = []
  const valueArray = []
  const sumArray = []
  for(const forecast of fileObj.forecasts){
    timeArray.push(forecast.period_end)
    valueArray.push(forecast.pv_estimate)
    sum += forecast.pv_estimate
    sumArray.push(sum)
  }

  return {
    timeArray,
    valueArray,
    sumArray
  }
}

async function forecastPowerConsumption(forecastStart, forecastEnd){

  let time = forecastStart
  const timeArray = []
  const valueArray = []
  while(time <= forecastEnd){
    const timeCursor = time.getHours() + time.getMinutes()/60 //minutes out of 60, eg 30 minutes is 0.5
    let load = 0
    for(const key in consumptionConfig){
      const item = consumptionConfig[key]
      if(item.startTime < timeCursor && item.startTime + item.duration >= timeCursor){
        load += item.load/2
      }
    }
       
    valueArray.push(load/1000)
    timeArray.push(time) 
    
    time = new Date(time.getTime() + 30*60*1000) // step forward 30 minutes in time
  }
  
  return {
    timeArray,
    valueArray
  } 
}

function addForecasts(forecast1, forecast2){

  if(forecast1.timeArray.length != forecast2.timeArray.length){
    throw Error('Forecast lengths differ')
  }

  const valueArray = []
  for(let i in forecast1.valueArray){
    const value = forecast1.valueArray[i] + forecast2.valueArray[i]
    valueArray.push(value)
  }

  const sumArray = []
  for(let i in forecast1.sumArray){
    const value = forecast1.sumArray[i] + forecast2.sumArray[i]
    sumArray.push(value)
  }

  return {
    timeArray: forecast1.timeArray,
    valueArray,
    sumArray
  }
}

async function forecastBatteryKWh(PVPowerForecast, powerConsumptionForecast){

  const SOC = await getLastStateOfCharge()
  let remainingKWh = batteryKWh*SOC
  
  if(PVPowerForecast.timeArray.length != powerConsumptionForecast.timeArray.length){
    throw Error('Forecast lengths differ')
  }

  const valueArray = []
  for(let i in PVPowerForecast.timeArray){
    // We need to devide the PVPowerForecast and the powerConsumptionForecast to take in to account that their values are the average over the last 30 minutes
    // TODO: The available capacity is not aligned to the half hour averages presented by the PVPowerForecast and powerConsumptionForecast, this needs to be addressed to be accurate
    const PVPowerVsConsumption = (PVPowerForecast.valueArray[i]/2)*inverterChargeEfficiency - (powerConsumptionForecast.valueArray[i]/2)*(1/inverterEfficiency)
    //console.log({PVPowerVsConsumption})

    if(remainingKWh + PVPowerVsConsumption >= batteryKWh){
      remainingKWh = batteryKWh // The battery can't charge beyond full
    } else if (remainingKWh + PVPowerVsConsumption <= spareKWh){
      remainingKWh = spareKWh // The battery is empty, it can't give any more power
    } else {
      remainingKWh += PVPowerVsConsumption
    }

    //console.log({remainingKWh})
    //console.log('time:', PVPowerForecast.timeArray[i])

    valueArray.push(remainingKWh)
  }

  return {
    valueArray,
    timeArray: PVPowerForecast.timeArray
  }
}

function generatePowerConsumptionForecast(key, forecastStart, forecastEnd){

  const item = consumptionConfig[key]

  let time = forecastStart
  const timeArray = []
  const valueArray = []
  while(time <= forecastEnd){
    const timeCursor = time.getHours() + time.getMinutes()/60 //minutes out of 60, eg 30 minutes is 0.5
    let load = 0

    if(!item.startTime){
      load = item.load/2
    } else if(item.startTime < timeCursor && item.startTime + item.duration >= timeCursor){
      load = item.load/2
    }
       
    valueArray.push(load/1000)
    timeArray.push(time) 
    
    time = new Date(time.getTime() + 30*60*1000) // step forward 30 minutes in time
  }
  
  return {
    timeArray,
    valueArray
  } 
}

function findIndexWhereRemainingKWhIsLessThanSpareKWh(batteryKWhForecast){

  for(let i = 0; i < batteryKWhForecast.valueArray.length; i++){
    const value = batteryKWhForecast.valueArray[i]
    if(value <= spareKWh){
      return i
    }
  }  

  return -1
}

async function findPowerConsumptionScheduleForKey(key, forecastStart, forecastEnd, totalPVPowerForecast, baselinePowerConsumptionForecast){
  
  let keyConsumptionForecast = generatePowerConsumptionForecast(key, forecastStart, forecastEnd)
  let combinedConsumptionForecast = addForecasts(baselinePowerConsumptionForecast, keyConsumptionForecast)
  let originalBatteryKWhForecast = await forecastBatteryKWh(totalPVPowerForecast, combinedConsumptionForecast)

  let index = findIndexWhereRemainingKWhIsLessThanSpareKWh(originalBatteryKWhForecast)
  console.log(key+' batteries will run out at '+originalBatteryKWhForecast.timeArray[index])

  let shutDownIndex = index
  let batteryKWhForecast

  while(index > 0 && shutDownIndex > 0){

    shutDownIndex--

    // Set all entries to 0 from the shutDownIndex going forward
    for(let i = shutDownIndex; i < keyConsumptionForecast.valueArray.length; i++){
      keyConsumptionForecast.valueArray[i] = 0
    }
     
    combinedConsumptionForecast = addForecasts(baselinePowerConsumptionForecast, keyConsumptionForecast)
    batteryKWhForecast = await forecastBatteryKWh(totalPVPowerForecast, combinedConsumptionForecast)

    index = findIndexWhereRemainingKWhIsLessThanSpareKWh(batteryKWhForecast)
  }
  
  if(shutDownIndex == 0){
    console.log(key+' needs to stop now')
  } else {
    console.log(key+' needs to stop at '+batteryKWhForecast.timeArray[shutDownIndex-1])
  }

  return {
    timeArray: batteryKWhForecast.timeArray,
    valueArray: batteryKWhForecast.valueArray,
    originalTimeArray: originalBatteryKWhForecast.timeArray,
    originalValueArray: originalBatteryKWhForecast.valueArray
  }
}

async function main(){

  const currentTimestamp = new Date().getTime()

  let northFileObj
  let eastFileObj
  if(fs.existsSync(northDbFilePath)){
    const northFileContents = fs.readFileSync(northDbFilePath).toString()
    northFileObj = JSON.parse(northFileContents)
  }

  if(fs.existsSync(eastDbFilePath)){
    const eastFileContents = fs.readFileSync(eastDbFilePath).toString()
    eastFileObj = JSON.parse(eastFileContents)
  }

  if(!northFileObj || currentTimestamp >= northFileObj.timestamp + timeBetweenUpdates){
    console.log('Updating solcast forcast')
    northFileObj = await updateFileDB(northPVForecastURL.href, northDbFilePath)
    eastFileObj = await updateFileDB(eastPVForecastURL.href, eastDbFilePath)
  }

  const northPVPowerForecast = await forecastPVPowerProduction(northFileObj)
  const eastPVPowerForecast = await forecastPVPowerProduction(eastFileObj)
  const totalPVPowerForecast = addForecasts(northPVPowerForecast, eastPVPowerForecast)

const data = [
    {
      x: northPVPowerForecast.timeArray,
      y: northPVPowerForecast.valueArray,
      type: 'line',
      name: 'north'
    },
    {
      x: eastPVPowerForecast.timeArray,
      y: eastPVPowerForecast.valueArray,
      type: 'line',
      name: 'east'
    },
    {
      x: totalPVPowerForecast.timeArray,
      y: totalPVPowerForecast.valueArray,
      type: 'line',
      name: 'total'
    },
    /*{
      x: totalPVPowerForecast.timeArray,
      y: totalPVPowerForecast.sumArray,
      type: 'line',
      name: 'sum(total)'
    }*/
  ]

/*
  const forecastStart = new Date(northPVPowerForecast.timeArray[0])
  const forecastEnd = new Date(northPVPowerForecast.timeArray[northPVPowerForecast.timeArray.length-1])
  
  const powerConsumptionForecast = await forecastPowerConsumption(forecastStart, forecastEnd)

  const baseBatteryKWhForecast = await forecastBatteryKWh(totalPVPowerForecast, powerConsumptionForecast)

  const gpuMiningBatteryKWhForecast = await findPowerConsumptionScheduleForKey('gpuMiner', forecastStart, forecastEnd, totalPVPowerForecast, powerConsumptionForecast)

  const data = [
    {
      x: baseBatteryKWhForecast.timeArray, 
      y: baseBatteryKWhForecast.valueArray, 
      type: 'line',
      name: 'baseBatteryKWhForecast'
    }, {
      x: gpuMiningBatteryKWhForecast.timeArray, 
      y: gpuMiningBatteryKWhForecast.valueArray, 
      type: 'line',
      name: 'gpuMiningBatteryKWhForecast'
    }, {
      x: gpuMiningBatteryKWhForecast.originalTimeArray, 
      y: gpuMiningBatteryKWhForecast.originalValueArray, 
      type: 'line',
      name: 'original gpuMiningBatteryKWhForecast'
    }
  ];
*/

  plot(data);
  
}

main()
