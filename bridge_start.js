const MultiDeviceBridge = require('./multi_bridge');

const bridge = new MultiDeviceBridge();

console.log("Starting Airplay to ChromeCast bridge...")
bridge.on('deviceFound', (device) => {
    console.log('Found Cast device:', device);
});

bridge.on('airplayReady', ({ deviceName, port }) => {
    console.log(`AirPlay ready for ${deviceName} on port ${port}`);
});

bridge.on('error', (error) => {
    console.error('Bridge error:', error);
});

bridge.start().catch(console.error);