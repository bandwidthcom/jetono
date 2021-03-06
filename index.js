"use strict";
let url = require("url");
let Joi = require("joi");
let co = require("co");
let bcrypt = require("bcryptjs");
let crypto = require("crypto");

const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const charlen = chars.length;


let optionsSchema = Joi.object().keys({
  tokenField: Joi.string().default("token"),
  validateToken: Joi.func(),
  minPasswordLength: Joi.number().integer().default(6),
  pepper: Joi.string().min(10).default("JcmjuDxZf8zm"),
  extendUserModel: Joi.func(),
  extendAccessTokenModel: Joi.func(),
  accessTokenCacheExpiresIn: Joi.number().default(300000)
});

function defineModels(plugin, options){
  plugin.dependency(["co-hapi-mongoose", "co-hapi-models"], function*(plugin){
    let db = plugin.plugins["co-hapi-mongoose"].mongoose;
    let userSchema, accessTokenSchema;
    if(!db.models.users){
      userSchema = new db.Schema({
        userName: {type: String, unique: true, required: true},
        encryptedPassword: String
      });

      userSchema.methods.setPassword = function*(password){
        if(!password){
          this.set("encryptedPassword", null);
          return;
        }
        let l = (options.minPasswordLength || 6);
        if(password.length < l){
          throw plugin.hapi.error.unauthorized("Password must contains more or equal " +  l + " symbols");
        }
        let hash = yield bcrypt.hash.bind(bcrypt, password + options.pepper, ((process.env.NODE_ENV == "test")?4:10));
        this.set("encryptedPassword", hash);
      };
      userSchema.methods.comparePassword = function*(password){
        let res = yield bcrypt.compare.bind(bcrypt, password + options.pepper, (this.get("encryptedPassword") || ""));
        return res;
      };
      if(options.extendUserModel){
        options.extendUserModel(userSchema);
      }
    }
    if(!db.models.accessTokens){
      accessTokenSchema = new db.Schema({
        token: {type: String, unique: true},
        user: {type: db.Schema.Types.ObjectId, ref: "users", required: true, index: true}
      });

      accessTokenSchema.pre("save", function(next){
        const length = 24;
        let self = this;
        if(self.token){
          return next();
        }
        crypto.randomBytes(length, function(err, buf){
          if(err) return next(err);
          let result = [];
          for(let i = 0; i < length; i ++){
            let index = (buf.readUInt8(i) % charlen);
            result.push(chars[index]);
          }
          self.token = result.join("");
          next();
        });
      });
      if(options.extendAccessTokenModel){
        options.extendAccessTokenModel(accessTokenSchema);
      }
    }
    yield plugin.methods.models.register({
      user: db.models.users || db.model("users", userSchema),
      accessToken: db.models.accessTokens || db.model("accessTokens", accessTokenSchema)
    });
  });
};


module.exports.register = function*(plugin, options){
  let result = Joi.validate(options, optionsSchema);
  if(result.error){
    throw new Error(result.error.annotate());
  }
  options = result.value;
  defineModels(plugin, options);
  let accessTokenCache = plugin.cache({segment: "!!accessTokenCache", expiresIn: options.accessTokenCacheExpiresIn || 300000});
  let validateToken = function* (plugin, models, token){
    return (yield accessTokenCache.getOrGenerate.bind(accessTokenCache, token, function(callback){co(function*(){
      let accessToken = yield models.accessToken.findOne({token: token}).populate("user").execQ();
      if(!accessToken){
        throw plugin.hapi.error.unauthorized("Invalid token");
      }
      return accessToken;
    })(callback);}))[0];
  };

  plugin.auth.scheme("jetono-token", function (server, config) {
    config = config || {};
    return {
      authenticate : function (request, reply) {
        co(function*(){
          let token = (request.headers.authorization || "").split(" ")[1];
          if(!token){
            token = (request.query || {})[options.tokenField];
          }
          if(!token){
            throw plugin.hapi.error.unauthorized();
          }
          if(!request.models){
            throw plugin.hapi.error.internal("plugin co-hapi-models is required");
          }
          let accessToken =  yield validateToken(plugin, request.models, token);
          let validateFunc = config.validateToken || options.validateToken;
          if(validateFunc){
            yield validateFunc(accessToken);
          }
          return {credentials: {username: accessToken.user.userName, id: accessToken.user.id}};
        })(reply);
      }
    };
  });

  function* createToken(request, userName, password){
    if(!request.models){
      throw plugin.hapi.error.internal("plugin co-hapi-models is required");
    }
    let user = yield request.models.user.findOne({userName: userName}).execQ();
    if(!user){
      throw plugin.hapi.error.unauthorized();
    }
    if(!(yield user.comparePassword(password))){
      throw plugin.hapi.error.unauthorized();
    }
    return {user: user, accessToken: yield new request.models.accessToken({user: user.id}).saveQ()};
  }

  plugin.auth.scheme("jetono-signin", function (server, config) {
    config = config || {};
    return {
      authenticate : function (request, reply) {
        co(function*(){
          let items = (request.headers.authorization || "").split(" ");
          if(items[0].toLowerCase() === "basic" && items[1]){
            items = new Buffer(items[1], "base64").toString().split(":");
            let result = yield createToken(request, items[0], items[1]);
            return {
              credentials: {username: result.user.userName, id: result.user.id},
              artifacts: {token: result.accessToken.token}
            };
          }
          return {
            credentials: {}
          };
        })(reply);
      },

      payload: function(request, next){
        //this function is not called if request.payload is missing
        co(function*(){
          if(request.auth.credentials
             && request.auth.credentials.userName
             && request.auth.artifacts
             && request.auth.artifacts.token){
            return;
          }
          request.payload = request.payload || {};
          let userName = request.payload[config.userNameField || "username"];
          let password = request.payload[config.passwordField || "password"];
          let result = yield createToken(request, userName, password);
          request.auth.credentials = {username: result.user.userName, id: result.user.id};
          request.auth.artifacts = {token: result.accessToken.token};
        })(next);
      }
    };
  });

  plugin.auth.scheme("jetono-signup", function (server, config) {
    config = config || {};
    return {
      authenticate : function (request, reply) {
        reply(null, {credentials: {}}); //nothing do here because we need access to payload
      },

      payload: function(request, next){
        co(function*(){
          let userName, password, repeatPassword;
          if(request.payload){
            userName = request.payload[config.userNameField || "username"];
            password = request.payload[config.passwordField || "password"];
            repeatPassword = request.payload[config.repeatPasswordField || "repeatPassword"];
          }
          if(!userName || !password || !repeatPassword){
            throw plugin.hapi.error.badRequest();
          }
          if(repeatPassword !== password){
            throw plugin.hapi.error.unauthorized("Passwords are mismatched");
          }
          if(!request.models){
            throw plugin.hapi.error.internal("plugin co-hapi-models is required");
          }
          let user = new request.models.user({userName: userName});
          yield user.setPassword(password);
          yield user.saveQ();
          let accessToken = yield new request.models.accessToken({user: user.id}).saveQ();
          request.auth.credentials = {username: user.userName, id: user.id};
          request.auth.artifacts = {token: accessToken.token};
        })(next);
      }
    };
  });
};

module.exports.register.attributes = {
  pkg: require("./package.json")
};
