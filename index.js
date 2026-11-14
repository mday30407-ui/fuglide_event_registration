const { createApp } = require("./server");

const app = createApp();

module.exports = app;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
