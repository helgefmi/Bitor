var sys = require('sys'),
    assert = require('assert'),
    Buffer = require('buffer').Buffer;

function encode(obj) {
    if (typeof(obj) == "number")
        return encode_integer(obj);
    else if (typeof(obj) == "string")
        return encode_string(obj);
    else if (obj instanceof Array)
        return encode_list(obj);
    else
        return encode_dict(obj);
}

function encode_integer(i) {
    assert.strictEqual(typeof(i), "number");
    return 'i' + i + 'e';
}
function encode_string(str) {
    assert.strictEqual(typeof(str), "string", str + ' (' + typeof(str) + ') is not a string.');
    /* Buffer doesn't like getting empty strings, so we'll handle this in a special case */
    if (str === '')
        return '0:';

    /* Using Buffer so we can be sure that the length is the length of the actual bytes, and not number of letters. */
    return (new Buffer(str, 'binary')).length + ':' + str;
}
function encode_list(list) {
    return 'l' + list.map(encode).join('') + 'e';
}
function encode_dict(dict) {
    var keys = [];
    for (var key in dict) {
        keys.push(key);
    }
    keys.sort();

    return 'd' + keys.map(function(key) {
        return encode_string('' + key) + encode(dict[key]);
    }).join('') + 'e';
}

/* Testcases */
(function() {
    var tests = [
        {input: 'hei', output: '3:hei'},
        {input: '', output: '0:'},
        {input: 'aB cD eF gH', output: '11:aB cD eF gH'},
        {input: 'Mitt navn har \u00e6 og \u00f8 og \u00e5 i seg!', output: '32:Mitt navn har \u00e6 og \u00f8 og \u00e5 i seg!'},
        {input: {interval: 60, leechers: 1, peers: 'PÕ]cáà', seeders: 0}, output: 'd8:intervali60e8:leechersi1e5:peers6:PÕ]cáà7:seedersi0ee'},

        {input: 42, output: 'i42e'},
        {input: -42, output: 'i-42e'},
        {input: 0, output: 'i0e'},
        {input: 1234567, output: 'i1234567e'},
        {input: -7654321, output: 'i-7654321e'},

        {input: [1, 2, "hei"], output: 'li1ei2e3:heie'},
        {input: [], output: 'le'},
        {input: [{1:2, '3':'4'}, 5, {6:7}], output: 'ld1:1i2e1:31:4ei5ed1:6i7eee'},

        {input: {test: 'tast', tall: 5}, output: 'd4:talli5e4:test4:taste'},
        {input: {liste: [1, 2, "hei"], tall: 5, streng: "japan", dikt: {test: "tast"}}, output: 'd4:diktd4:test4:taste5:listeli1ei2e3:heie6:streng5:japan4:talli5ee'},
    ];

    for (var i = 0; i < tests.length; ++i) {
        assert.strictEqual(encode(tests[i].input), tests[i].output);
    }
})();

exports.encode_integer = encode_integer;
exports.encode_string = encode_string;
exports.encode_list = encode_list;
exports.encode_dict = encode_dict;
exports.encode = encode;
