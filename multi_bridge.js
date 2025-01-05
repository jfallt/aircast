const { Client, DefaultMediaReceiver } = require('castv2-client');
const bonjour = require('bonjour')();
const ShairportBridge = require('./shairport_bridge');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const EventEmitter = require('events');
const net = require('net');
const path = require('path');

class MultiDeviceBridge extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            ffmpegCodec: options.ffmpegCodec || 'libmp3lame',
            ffmpegBitrate: options.ffmpegBitrate || '192k',
            ...options
        };

        this.castDevices = new Map();
        this.bridges = new Map();
        this.browser = null;
    }

    async findAvailablePort(startPort = 5000, maxTries = 10) {
        const isPortAvailable = (port) => {
            return new Promise((resolve) => {
                const server = net.createServer();
                server.listen(port, () => {
                    server.once('close', () => resolve(true));
                    server.close();
                });
                server.on('error', () => resolve(false));
            });
        };

        for (let port = startPort; port < startPort + maxTries; port++) {
            if (await isPortAvailable(port)) {
                return port;
            }
        }
        throw new Error('No available ports found');
    }

    async setupShairportForDevice(deviceName, port) {
        const bridge = new ShairportBridge({
            name: `AirPlay to ${deviceName}`,
            port: port,
            output: 'pipe',
            configPath: path.join(process.cwd(), `shairport-sync-${deviceName}.conf`)
        });

        bridge.on('started', () => {
            this.emit('airplayReady', { deviceName, port });
            this.connectToCastDevice(deviceName);
        });

        bridge.on('metadata', (metadata) => {
            this.updateCastMetadata(deviceName, metadata);
        });

        bridge.on('error', (error) => {
            this.emit('error', { source: 'shairport', deviceName, error });
        });

        return bridge;
    }

    async startDeviceDiscovery() {
        try {
            // Find Chromecast devices using Bonjour
            this.browser = bonjour.find({ type: 'googlecast' });

            this.browser.on('up', async (service) => {
                try {
                    const deviceInfo = this.extractDeviceInfo(service);

                    if (!deviceInfo) {
                        return;
                    }

                    if (this.castDevices.has(deviceInfo.name)) {
                        return;
                    }

                    console.log('Found Cast device:', deviceInfo);
                    this.castDevices.set(deviceInfo.name, deviceInfo);
                    this.emit('deviceFound', deviceInfo);

                    const port = await this.findAvailablePort(5000 + this.bridges.size);
                    const bridge = await this.setupShairportForDevice(deviceInfo.name, port);
                    this.bridges.set(deviceInfo.name, {
                        bridge,
                        streamingProcess: null,
                        client: null,
                        player: null
                    });

                    await bridge.start();
                } catch (error) {
                    console.error('Error processing discovered device:', error);
                    this.emit('error', { source: 'device-processing', error });
                }
            });

            this.browser.on('down', (service) => {
                const deviceInfo = this.extractDeviceInfo(service);
                if (deviceInfo && deviceInfo.name) {
                    this.castDevices.delete(deviceInfo.name);
                    this.handleDeviceDisconnection(deviceInfo.name);
                    this.emit('deviceLost', deviceInfo.name);
                }
            });

            console.log('Starting Cast device discovery...');
        } catch (error) {
            console.error('Error during device discovery setup:', error);
            this.emit('error', { source: 'discovery', error: error.message || error });
        }
    }

    extractDeviceInfo(service) {
        try {
            if (!service.name) {
                return null;
            }

            // Clean up the device name
            const cleanName = service.name
                .replace(/[._]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            return {
                name: cleanName,
                host: service.host,
                port: service.port,
                type: service.type,
                model: service.txt?.md || 'Unknown',
                isGroup: false // Bonjour doesn't provide this info directly
            };
        } catch (error) {
            console.error('Error extracting device info:', error);
            return null;
        }
    }

    handleDeviceDisconnection(deviceName) {
        const bridgeInfo = this.bridges.get(deviceName);
        if (bridgeInfo) {
            if (bridgeInfo.streamingProcess) {
                bridgeInfo.streamingProcess.kill();
            }
            if (bridgeInfo.client) {
                bridgeInfo.client.close();
            }
            bridgeInfo.bridge.stop();
            this.bridges.delete(deviceName);
        }
        this.emit('deviceDisconnected', deviceName);
    }

    async connectToCastDevice(deviceName) {
        const device = this.castDevices.get(deviceName);
        const bridgeInfo = this.bridges.get(deviceName);

        if (!device || !bridgeInfo) {
            throw new Error(`Device ${deviceName} not found`);
        }

        try {
            const client = new Client();

            await new Promise((resolve, reject) => {
                client.connect(device.host, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            client.on('error', (error) => {
                this.emit('error', { source: 'cast', deviceName, error });
                this.handleDeviceDisconnection(deviceName);
            });

            bridgeInfo.client = client;
            await this.setupMediaReceiver(deviceName);
            this.emit('castConnected', deviceName);
            await this.startAudioStreaming(deviceName);
        } catch (error) {
            this.emit('error', { source: 'cast', deviceName, error });
            throw error;
        }
    }

    async setupMediaReceiver(deviceName) {
        const bridgeInfo = this.bridges.get(deviceName);
        if (!bridgeInfo?.client) return;

        try {
            const player = await new Promise((resolve, reject) => {
                bridgeInfo.client.launch(DefaultMediaReceiver, (err, player) => {
                    if (err) reject(err);
                    else resolve(player);
                });
            });

            player.on('status', (status) => {
                this.emit('playerStatus', { deviceName, status });
            });

            bridgeInfo.player = player;
        } catch (error) {
            this.emit('error', { source: 'mediaReceiver', deviceName, error });
            throw error;
        }
    }

    async startAudioStreaming(deviceName) {
        const bridgeInfo = this.bridges.get(deviceName);
        if (!bridgeInfo?.player) {
            throw new Error(`No active Cast device for ${deviceName}`);
        }

        try {
            const pipePath = `/tmp/airplay-audio-${deviceName}`;
            await new Promise((resolve) => {
                const mkfifo = spawn('mkfifo', [pipePath]);
                mkfifo.on('close', resolve);
            });

            bridgeInfo.streamingProcess = ffmpeg()
                .input(pipePath)
                .inputFormat('s16le')
                .audioFrequency(44100)
                .audioChannels(2)
                .audioCodec(this.options.ffmpegCodec)
                .audioBitrate(this.options.ffmpegBitrate)
                .format('mp3')
                .on('error', (error) => {
                    this.emit('error', { source: 'ffmpeg', deviceName, error });
                })
                .on('end', () => {
                    this.emit('streamingEnded', deviceName);
                });

            const media = {
                contentId: `bridge-stream-${deviceName}`,
                contentType: 'audio/mp3',
                streamType: 'LIVE',
                metadata: {
                    type: 0,
                    metadataType: 0,
                    title: `AirPlay Stream to ${deviceName}`
                }
            };

            await new Promise((resolve, reject) => {
                bridgeInfo.player.load(media, { autoplay: true }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            bridgeInfo.streamingProcess.pipe(bridgeInfo.player);
            this.emit('streamingStarted', deviceName);
        } catch (error) {
            this.emit('error', { source: 'streaming', deviceName, error });
            throw error;
        }
    }

    updateCastMetadata(deviceName, metadata) {
        const bridgeInfo = this.bridges.get(deviceName);
        if (!bridgeInfo?.player) return;

        const mediaInfo = {
            contentId: `bridge-stream-${deviceName}`,
            contentType: 'audio/mp3',
            streamType: 'LIVE',
            metadata: {
                type: 0,
                metadataType: 0,
                title: metadata.title || `AirPlay Stream to ${deviceName}`,
                artist: metadata.artist,
                album: metadata.album
            }
        };

        bridgeInfo.player.updateMedia(mediaInfo, (err) => {
            if (err) {
                this.emit('error', { source: 'metadata', deviceName, error: err });
            }
        });
    }

    async start() {
        try {
            await new Promise((resolve) => {
                const kill = spawn('killall', ['shairport-sync']);
                kill.on('error', () => resolve());
                kill.on('close', resolve);
            });

            await this.startDeviceDiscovery();
            this.emit('started');
        } catch (error) {
            this.emit('error', { source: 'bridge', error });
            throw error;
        }
    }

    async stop() {
        for (const [deviceName, bridgeInfo] of this.bridges) {
            this.handleDeviceDisconnection(deviceName);
        }

        if (this.browser) {
            this.browser.stop();
            bonjour.destroy();
        }

        this.emit('stopped');
    }

    getDeviceList() {
        return Array.from(this.castDevices.values());
    }

    getBridgeStatus(deviceName) {
        const bridgeInfo = this.bridges.get(deviceName);
        return bridgeInfo ? {
            isRunning: bridgeInfo.bridge.isRunning,
            hasClient: !!bridgeInfo.client,
            hasPlayer: !!bridgeInfo.player,
            isStreaming: !!bridgeInfo.streamingProcess
        } : null;
    }
}

module.exports = MultiDeviceBridge;
