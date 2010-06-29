var sys = require('sys'),
    http = require('http'),
    querystring = require('querystring'),
    url = require('url'),
    bencode = require('./bencode');

var Peer = (function() {
    var Peer = function(id, file) {
        this.id = id;
        this.file = file;
        this.state = 'unknown';
        this.last_action_time = new Date();
    };

    Peer.prototype = {
        update_status: function(query) {
            if (typeof(query.uploaded) !== 'undefined')
                this.uploaded = query.uploaded;
            if (typeof(query.downloaded) !== 'undefined')
                this.downloaded = query.downloaded;
            if (typeof(query.left) !== 'undefined')
                this.left = query.left;

            if (typeof(query.event) !== 'undefined' && query.event) {
                switch(query.event) {
                    case 'started':
                        if (this.state == 'stopped')
                            this.file.leechers += 1;
                        break;
                    case 'stopped':
                        if (this.state == 'started')
                            this.file.leechers -= 1;
                        else if (this.state == 'completed')
                            this.file.seeders -= 1;

                        break;
                    case 'completed':
                        if (this.state == 'started')
                            this.file.leechers -= 1;
                        this.file.seeders += 1;
                        break;
                    default:
                        return;
                }
                this.state = query.event;
            }
        },

        dict: function (no_peer_id) {
            var ret = {
                ip: this.ip,
                port: this.port
            };
            if (!no_peer_id) {
                ret.id = this.id;
            }

            return ret;
        },

        compact: function() {
            var ret = '';
            var ip_numbers = this.ip.split('.');
            if (ip_numbers.length !== 4)
                return '';

            for (var i = 0; i < 4; ++i) {
                var n = parseInt(ip_numbers[i]);
                if (!n || n > 255) {
                    sys.debug('Invalid IP: ' + this.ip);
                    return '';
                }

                ret += String.fromCharCode(n);
            }

            if (this.port <= 0 || this.port >= 65536)
                return '';

            ret += String.fromCharCode(this.port >> 8);
            ret += String.fromCharCode(this.port & 255);

            return ret;
        }
    };

    return Peer;
})();

var File = (function() {
    var File = function(hash) {
        this.hash = hash;
        this.peers = [];

        this.seeders = 0;
        this.leechers = 0;
    }

    File.prototype = {
        get_peer: function(id) {
            var peer;
            for (var i = 0; i < this.peers.length; ++i) {
                if (this.peers[i].id === id) {
                    peer = this.peers[i];
                    break;
                }
            }

            if (!peer) {
                peer = new Peer(id, this);
                this.peers.push(peer);
            } else {
                peer.last_action_time = new Date();
            }
            return peer;
        },
        get_peers: function(numwant) {
            if (numwant <= this.peers.length) {
                return this.peers;
            }

            var ret = [],
                chosen = {};
            while (numwant--) {
                var idx = Math.floor(Math.random() * this.peers.length);
                if (chosen[idx])
                    continue;

                chosen[idx] = true;
                ret.push(this.peers[idx]);
            }
            return ret;
        },
    }

    return File;
})();

var Bitor = (function() {
    var Bitor = function(config) {
        this.ip = config.ip;
        this.port = config.port;
        this.files = [];

        this.default_numwant = config.numwant || 50;
        this.announce_url = config.announce_url || '/announce';
        this.interval = config.interval || 60;
        this.idle_ms_limit = config.idle_ms_limit || 10 * 60 * 1000;
    };

    Bitor.prototype = {
        remove_old_peers: function() {
            var now = new Date();
            for (var i = 0; i < this.files.length; ++i) {
                var file = this.files[i];
                for (var j = 0; j < file.peers.length; ++j) {
                    var peer = file.peers[j];
                    if (now - peer.last_action_time > this.idle_ms_limit) {
                        file.peers[j].file = null;
                        file.peers.splice(j, 1);
                        --j;
                    }
                }

                if (file.peers.length == 0) {
                    this.files.splice(i, 1);
                    --i;
                }
            }
        },

        get_file: function(info_hash) {
            var file;
            for (var i = 0; i < this.files.length; ++i) {
                if (this.files[i].hash === info_hash) {
                    file = this.files[i];
                    break;
                }
            }

            if (!file) {
                var file = new File(info_hash);
                this.files.push(file);
            }
            return file;
        },

        start: function() {
            var me = this;

            this.server = http.createServer(function (req, res) {
                function send_error(errno, msg) {
                    res.writeHead(200, {'Content-Type': 'text/plain'});
                    res.end(bencode.encode({'failure': msg, 'failure code': errno}));
                }

                if (req.method !== 'GET') {
                    return send_error(100, 'Invalid request type: client request was not a HTTP GET.');
                }

                var request = url.parse(req.url);
                if (request.pathname === me.announce_url) {
                    var query = querystring.parse(request.query);

                    /* List of required HTTP query parameters, linked to the HTTP status code associated with missing that parameter */
                    var required_parameters = {
                        'info_hash': 101,
                        'peer_id': 102,
                        'port': 103
                    };

                    for (var parameter in required_parameters) {
                        if (typeof(query[parameter]) === 'undefined') {
                            var status_code = required_parameters[parameter];
                            return send_error(status_code, 'Missing ' + parameter + '.');
                        }
                    }

                    if (query.info_hash.length !== 20)
                        return send_error(150, 'Invalid infohash: infohash is not 20 bytes long.');

                    if (query.peer_id.length !== 20)
                        return send_error(151, 'Invalid peerid: peerid is not 20 bytes long.');

                    var file = me.get_file(query.info_hash);
                    var peer = file.get_peer(query.peer_id);

                    peer.port = query.port;
                    if (typeof(query.ip) !== 'undefined') {
                        peer.ip = query.ip;
                    } else {
                        peer.ip = req.remoteAddress;
                    }

                    peer.update_status(query);

                    var numwant = query.numwant || me.default_numwant;
                    var peers = file.get_peers(numwant);

                    var response =  {
                        'interval': me.interval,
                        'seeders': file.seeders,
                        'leechers': file.leechers
                    }

                    if (typeof(query.compact) !== 'undefined') {
                        response.peers = peers.map(function(peer) {
                            return peer.compact();
                        }).join('');
                    } else {
                        response.peers = peers.map(function(peer) {
                            return peer.dict(typeof(query.no_peer_id !== 'undefined'));
                        });
                    }

                    var response = bencode.encode_dict(response);

                    res.writeHead(200, {'Content-Type': 'text/plain'});
                    res.end(response);
                }

                return send_error(600, 'Session should have ended, but it didnt..');
            });

            this.server.listen(this.port, this.ip, function() {
                sys.puts('Server running at http://' + me.ip + ':' + me.port + '/');

                setInterval(function() {
                    me.remove_old_peers();
                }, 5 * 60 * 1000);
            });
        },
    };

    return Bitor;
})();

exports.Bitor = Bitor;
