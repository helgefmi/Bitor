#!/usr/bin/env node

var sys = require('sys'),
    Bitor = require('./bitor').Bitor;

if (process.argv.length < 3) {
    sys.error('Error: No arguments\n');
    sys.error('./bitor <ip:port>\n');
    process.exit(1)
}

var ip_and_port = process.argv[2];
var ip = ip_and_port.substr(0, ip_and_port.indexOf(':'));
var port = parseInt(ip_and_port.substr(ip_and_port.indexOf(':') + 1));

if (!port || !ip) {
    sys.error('Error: Invalid ip:port.\n');
    sys.error('./bittor <ip:port>\n');
    process.exit(1);
}

var tracker = new Bitor({
    ip: ip,
    port: port
});
tracker.start();
