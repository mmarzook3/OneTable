#!/bin/sh
# Install root-owned; sudoers allows ONLY this receiver, never a shell/systemctl/docker.
exec sudo -n /usr/local/lib/scanaki-home-deploy/receiver.py "$SSH_ORIGINAL_COMMAND"
