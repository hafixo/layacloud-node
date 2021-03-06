/**
 * 关于玩家
 */
const moment = require('moment')
const later = require('later')
const uniqid = require('uniqid');
var CenterHelper = require('../foundation/center_helper')
const PUtil = require('./protocol_util.js')

function User(game, userId, socket) {
  this._uniq = uniqid()
  this.id = userId
  this.roomId = null
  this.socket = socket
  this._lastMsgTime = 0   // 最后一个消息时间(sec)
  later.date.localTime()

  this._game = game
  this.state = app.consts.USER_STATE.INIT
  this.isSupervisor = (socket == null)    // 是否为监督模式
  this._msgHandlers = new Map()
  this._setupListener()
  logger.debug("构造User:%s 游戏:%s", userId, game.id)
}

/**
 * 初始化
 */
User.prototype.init = function() {
  this.regMsgHandler("user.match", this._onReqUserMatch.bind(this))
  this.regMsgHandler("room.leave", this._onReqRoomLeave.bind(this))
  this._startHeartTimer()
  return true
}

/**
 * 获取user对应的game信息
 */
User.prototype.getGame = function() {
  return this._game
}

/**
 * 设置room id
 * @param {string} roomId 
 */
User.prototype.setRoomId = function(roomId = null) {
  logger.debug("设置用户:%s 的room id为:", this.id, roomId?roomId:"空")
  this.roomId = roomId
  //下线的时候发
  this.last_room_id = roomId
}

/**
 * 更新用户socket
 * @param {*} socket 
 */
User.prototype.updateSocket = function(socket) {
  if(!socket) {
    return
  }
  if(this.socket == null) {
    this.socket = socket
    this.isSupervisor = false
    this._startHeartTimer()
    this._setupListener()
  }
}

/**
 * 设置玩家状态
 * @param {string} state
 */
User.prototype.setState = function(state) {
  this.state = state
}

/**
 * 判断玩家是否数据加载完成
 */
User.prototype.isDataLoaded = function() {
  return this.state != app.consts.USER_STATE.INIT
}

/**
 * 注册消息回调
 * @param {*} type 
 * @param {*} cb 
 */
User.prototype.regMsgHandler = function(type, cb) {
  if(!cb) {
    return
  }
  let handlers = null
  if(!this._msgHandlers.has(type)) {
    handlers = []
    this._msgHandlers.set(type, handlers)
  } else {
    handlers = this._msgHandlers.get(type)
  }
  if(handlers.indexOf(cb) != -1) {
    return
  }
  handlers.push(cb)
}

/**
 * 发送消息
 * @param {*} msg 发送的消息
 */
User.prototype.send = function(data) {
  logger.debug("向用户:%s (socket:%s) 发送数据:\n", this.id, this.socket?"可用":"空", data)
  if(!this.socket) return
  if(this.socket.readyState != 1) {
    logger.info("用户:%s 的socket没有处于open状态", this.id)
    return
  }
  if(typeof data != "string") {
    data = JSON.stringify(data)
  }
  this.socket.send(data)
}

/**
 * 建立socket的各种listener
 */
User.prototype._setupListener = function() {
  if(!this.socket) {
    return
  }
  // logger.debug(">> socket 建立监听!", this.id)
  this.socket.on('close', this._onclose.bind(this))
  this.socket.on('error', this._onerror.bind(this))
  this.socket.on('message', this._onmessage.bind(this))
}

User.prototype._onclose = function(code) {
  logger.debug("玩家:%s socket 关闭，code:", this.id, code)
  this.state = app.consts.USER_STATE.DISCONNECT
  this._notifyPlayerOffline()
  this.doLogout()
}

User.prototype._onerror = function(err) {
  logger.info("玩家:%s socket 报错:", this.id, err)
  this.state = app.consts.USER_STATE.DISCONNECT
  this._notifyPlayerOffline()
  this.doLogout()
}

User.prototype._onmessage = function(data) {
  logger.debug("玩家:%s 收到消息:", this.id, data)
  try {
    let packet = JSON.parse(data)
    this._handleHeartPacket(packet)

    if(this._msgHandlers.has(packet.url)) {
      let cbList = this._msgHandlers.get(packet.url)
      for(let cb of cbList) {
        cb(packet)
      }
    } else {
      if(packet.url != "room.evt" || !packet.params) {
        // FIXME: engine只能处理room.evt么?
        return
      }
      let room = this._getRoom()
      if(room) {
        let params = packet.params
        let [key] = Object.keys(params)
        room.onClientMsg(this.id, key, params[key])
      } else {
        logger.debug("玩家:%s 收到消息，但是roomId为null! uniq:", this.id, this._uniq)        
        logger.debug(app.gameMgr.inspect2(this._game.id))
      }
  
    }
  } catch(e) {
    logger.error("玩家:%s 处理消息报错:", this.id, e)
  }
}

/**
 * 玩家下线
 */
User.prototype.doLogout = function(reason = 0) {
  logger.debug("玩家:%s 执行doLogout", this.id)
  if(this.socket) {
    if(reason != app.consts.LEAVEROOM_REASON.ROUND_FINISH) {
      this.socket.close()
      this.socket = null
    } 
  }
  if(this.roomId) {
    this._game.roomMgr.leaveRoom(this.roomId, this.id, reason)
  }
  if(reason != app.consts.LEAVEROOM_REASON.ROUND_FINISH) {
    this._game.userMgr.deleteUser(this.id)
  }
}

/**
 * 玩家状态
 */
User.prototype.inspect2 = function() {
  let result = ''
  result += ' id:' + this.id 
    + ' uniq:' + this._uniq
    + ' roomId:' + this.roomId
    + ' socket:' + (this.socket?"可用":"空")
    + ' state:' + this.state
    + ' supervisor:' + this.isSupervisor
  return result
}

/*********************
 * internal API
 *********************/

/**
 * 获取room
 */
User.prototype._getRoom = function() {
  if(!this.roomId) {
    return null
  }
  return this._game.roomMgr.getRoom(this.roomId)
}

/**
 * 当收到匹配请求
 * @param {*} packet 
 */
User.prototype._onReqUserMatch = async function(packet) {
  logger.debug("收到玩家:%s user.match请求", this.id)
  let roomType = packet.params.roomtype
  let config = this._game.config["room_define"][roomType]
  let matchValue = this._getMatchValue(config["match_field_name"])
  CenterHelper.match_game_to_center(this._game.id, this.id, config, matchValue, function(err, resp) {
    if(err) {
      logger.warn("用户匹配应答报错!error:", err)
      return
    }
    // logger.debug("用户匹配返回:", resp)
  })
}

/**
 * 当收到leave消息
 * @param {*} packet 
 */
User.prototype._onReqRoomLeave = async function(packet) {
  let reason = packet.params.reason
  if(reason == app.consts.LEAVEROOM_REASON.ROUND_FINISH) {
    logger.info("对局结束，玩家:%s 请求离开房间 room.leave", this.id)
    if(!this.roomId) return
    CenterHelper.switch_to_home(this._game.id, this.id, this.roomId, (err, resp) => {
      if(err) {
        logger.warn("玩家:%s 向center请求返回大厅失败:", err)
        return
      }
    })
    this.doLogout(reason)
  }
}

/**
 * 获取匹配使用的数值
 * @param {*} matchField 
 */
User.prototype._getMatchValue = function(matchField) {
  // FIXME: 获取匹配数据需要经过共识,此处可能造假
  let data = this._game.engineData.getUserData(this.id)
  let fieldName = matchField.replace(/[a-zA-Z_0-9]+\./, "")
  if(fieldName in data) {
    return data[fieldName]
  } else {
    logger.info("玩家:%s 无此匹配数据字段:%s", this.id, fieldName)
    return 0
  }
}

/**
 * 启动心跳检测
 */
User.prototype._startHeartTimer = function() {
  if(this._checkHeartRunning) {
    return
  }
  let sched = later.parse.recur()
    .every(5).second()
  this._checkHeartTimer = later.setInterval(this._onCheckHeartTimeout.bind(this),  sched)
  this._checkHeartRunning = true
}

/**
 * 检测心跳timer
 */
User.prototype._onCheckHeartTimeout = function() {
  if(this.state == app.consts.USER_STATE.DISCONNECT) {
    this._clearHeartTimer()
    return
  }
  let now = moment().unix()
  // logger.debug(">> heart timeout now:", now, "last:", this._lastMsgTime)
  if(this._lastMsgTime != 0 && now - this._lastMsgTime > 30) {
    logger.info("玩家:%s 心跳超时，关闭", this.id)
    this._notifyPlayerOffline()
    this.doLogout()
    this._clearHeartTimer()
  }
}

/**
 * 处理心跳包
 * @param {*} packet 
 */
User.prototype._handleHeartPacket = function(packet) {
  let isHeart = (Object.keys(packet).length == 0)
  if(isHeart || packet.url) {
    // 心跳包或者其它数据包
    this._lastMsgTime = moment().unix()
  }
  if(isHeart) {
    this.send("{}")
  }
}

/**
 * 通知center玩家下线
 */
User.prototype._notifyPlayerOffline = function() {
  if(this.isSupervisor) return
  CenterHelper.player_offline(this._game.id, this.id, this.last_room_id, function(err, resp) {
    if(err) {
      logger.warn("提交用户offline报错!error:", err)
      return
    }
    // TODO: 如果提交失败，是否会导致center一直认为玩家在线？
    // 是否需要某种重试机制
  })
}

/**
 * 清理heart timer
 */
User.prototype._clearHeartTimer = function() {
  if(!this._checkHeartRunning) return
  this._checkHeartTimer.clear()
  this._checkHeartRunning = false;
}

module.exports = User