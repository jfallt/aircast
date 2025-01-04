#!/usr/bin/env bash
#make sure the vagrant user is in the audio group
sudo usermod -a -G audio vagrant

#install the newest alsa kernel modules
sudo apt-add-repository ppa:ubuntu-audio-dev/alsa-daily
sudo apt-get update
sudo apt-get install oem-audio-hda-daily-dkms

#reload sound module
sudo modprobe snd-hda-intel

sudo apt-get install -yq git wget curl autoconf libtool libdaemon-dev libasound2-dev libpopt-dev libconfig-dev avahi-daemon libavahi-client-dev libssl-dev libsoxr-dev 
sudo apt-get install -yq libplist-dev libsodium-dev libgcrypt-dev libavutil-dev libavcodec-dev libavformat-dev
sudo apt-get install -yq build-essential git libavahi-compat-libdnssd-dev

#also do https://wiki.ubuntuusers.de/Soundkarten_konfigurieren/HDA?redirect=no
sudo apt-get -yq remove --purge alsa-base pulseaudio

# Install and configure PulseAudio with the RTP module
sudo apt-get -yq install alsa-base pulseaudio pulseaudio-module-raop alsa-utils
sudo alsa force-reload
echo "options snd-hda-intel model=3stack" | sudo tee -a /etc/modprobe.d/alsa-base.conf

# Add casting client
mkdir temp
cd temp
rm -rf node_modules

# Ensure latest version of node
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
sudo apt-get install -y npm
nvm install --lts
nvm use --lts

# Update packages
npm install
npm install castv2-client mdns naudiodon node-lame pcm-stream fluent-ffmpeg @homebridge/ciao

cd ..

# install shairport-sync
git clone --depth=1 https://github.com/mikebrady/shairport-sync.git
cd shairport-sync
autoreconf -i -f
./configure --with-alsa --with-avahi --with-ssl=openssl --with-metadata --with-soxr --with-stdout
make
sudo make install

# Start the audio bridge
cd ..
node -v
node bridge_start.js