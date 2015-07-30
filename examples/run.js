var  mqtt2opc = require("../mqtt2opcua").run;
var  Events = require('events').EventEmitter;

forward = new Events();
backward = new Events();

// Set up forward and reverse data conversion functions
// These are based on topic path - the finer grained pattern will be used.
// Examples below

forward.on("$SYS/broker/bytes/#", function(payload) {
    return {
            dataType: "Int32",
            value: parseInt(payload)
         };
});

backward.on("$SYS/broker/bytes/#", function(variant) {
            return {
                topic:variant.topic,
                payload:variant.value
            };
});

options = {
    opcName:"MQTT Local",
    opcHost:"localhost",
    opcPort:"4335",
    mqttHost:"localhost",
    mqttPort:"1883",
    debug:true,
    roundtrip:false,	// set to true to limit updates to onMessage (i.e. validate an accuator is set)
    forward:forward,	// data converter - mqtt -> opcua
    backward:backward,	// data converter - opcua -> mqtt
    //topics:['#','$SYS/broker/#'] // Customize to override. These are the default so uncessary.
};

var server = new mqtt2opc(options);


