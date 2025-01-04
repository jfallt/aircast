const { spawn } = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

class ShairportBridge extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            name: options.name || 'Node AirPlay',
            port: options.port || 5000,
            output: options.output || 'pipe',
            alsaDevice: options.alsaDevice || 'default',
            configPath: options.configPath || path.join(process.cwd(), 'shairport-sync.conf'),
            ...options
        };

        this.process = null;
        this.isRunning = false;
    }

    generateConfig() {
        const config = `
general = {
  name = "${this.options.name}";
  port = ${this.options.port};
  drift_tolerance_in_seconds = 0.002;
  resync_threshold_in_seconds = 0.050;
  ignore_volume_control = "no";
};

sessioncontrol = {
  run_this_before_play_begins = "/usr/bin/logger -t 'Shairport Sync' 'Play Begin'";
  run_this_after_play_ends = "/usr/bin/logger -t 'Shairport Sync' 'Play End'";
  wait_for_completion = "no";
};

audio = {
  output_type = "${this.options.output}";
  ${this.options.output === 'alsa' ? `output_device = "${this.options.alsaDevice}";` : ''}
};

metadata = {
  enabled = "yes";
  include_cover_art = "yes";
  pipe_name = "/tmp/shairport-sync-metadata";
};
        `;

        fs.writeFileSync(this.options.configPath, config);
        return this.options.configPath;
    }

    async start() {
        if (this.isRunning) {
            throw new Error('Shairport Sync is already running');
        }

        const configPath = this.generateConfig();

        try {
            this.process = spawn('shairport-sync', ['-c', configPath]);
            this.isRunning = true;

            this.process.stdout.on('data', (data) => {
                this.emit('log', data.toString());
            });

            this.process.stderr.on('data', (data) => {
                this.emit('error', new Error(data.toString()));
            });

            this.process.on('close', (code) => {
                this.isRunning = false;
                this.emit('close', code);
            });

            this.setupMetadataPipe();

            this.emit('started');
            return true;
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    setupMetadataPipe() {
        const metadataPipe = '/tmp/shairport-sync-metadata';

        if (!fs.existsSync(metadataPipe)) {
            spawn('mkfifo', [metadataPipe]);
        }

        const reader = fs.createReadStream(metadataPipe);