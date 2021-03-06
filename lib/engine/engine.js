/**
 * 关于游戏运行环境
 * 基于nodejs vm实现
 */
const vm = require('vm')
const EngineSupervisor = require('./engine_supervisor.js')
const PUtil = require('../game/protocol_util.js')

function Engine(game, room, roomName, isSupervisor) {
  this._game = game
  this._room = room
  this._inited = false
  this._roomName = roomName
  this._userList = []
  this._userListPrev = []

  this._broadcastPending = []
  this._sendPending = []

  this._frameCount = 0  // 帧数
  this._isSupervisor = isSupervisor // 是否为监督节点
  this._runUpdateLoop = false   // js代码是否启动了update loop函数

  // 沙箱对象
  let engineAdapter = {}
  this.sandbox = {console: console, engine:engineAdapter}
}

/**
 * 初始化engine
 */
Engine.prototype.init = function() {
  if(this._inited) return true
  vm.createContext(this.sandbox)
  if(!this._initProperty(this._game.id, this._game.config)) {
    return false
  }
  // logger.debug("room:%s engine进行初始化, game:%s 房间类型:%s 监督节点:", this._room.id, this._game.id, this._roomName, this._isSupervisor)
  try {
    const code = _codeWrap(this._game.code[this._roomName])
    // logger.debug("engine 加载代码:%s", code)
    vm.runInContext(code, this.sandbox)
    this.sandbox.engine.oncreated()
  } catch(e) {
    logger.error("run vm error:", e)
  }

  // 初始化loop相关, supervisor不启动loop，通过logic event驱动
  let interval = 1000
  if(!this._isSupervisor) {
    let loopCb = (function() {
      if(this._runUpdateLoop) {
        this._room.syncEventToSup("onSupUpdate", [])
        this.sandbox.engine.onupdate()
      }
      this._frameCount++
    }).bind(this)
    this._startLoop(interval, loopCb)
  } else {
    this._supervisor = new EngineSupervisor(this)
  }

  this._inited = true
  return true
}

/**
 * 监督节点执行的update函数
 */
Engine.prototype.onSupUpdate = function() {
  if(this._runUpdateLoop) {
    this.sandbox.engine.onupdate()
  }
}

/**
 * 获取帧数
 */
Engine.prototype.getFrameCount = function() {
  return this._frameCount
}

/**
 * 增加帧数
 * @param {*} n 
 */
Engine.prototype.incFrameCount = function(n) {
  this._frameCount += n
  return this._frameCount
}

/**
 * 获取所有的user id 列表
 * @returns array
 */
Engine.prototype.getusersid = function() {
  return this._userList;
}

/**
 * 获取用户数据，参数为用户ID
 */
Engine.prototype.getuserdata = function(id) {
  return this._game.engineData.getUserData(id)
}

/**
 * 保存用户数据 
 * @param {string} id 
 */
Engine.prototype.saveuserdata = function(id) {
  this._game.engineData.saveUserData(id)
}

/**
 * 添加房间数据
 * @param {string} key 
 * @param {string} value 
 */
Engine.prototype.addroomdata = function(key, value) {
  this._game.engineData.addRoomData(this._room.id, key, value)
}

/**
 * 获取房间的所有数据
 */
Engine.prototype.getroomdata = function() {
  this._game.engineData.getRoomData(this._room.id)
}

/**
 * 向房间内用户广播一条消息
 * @param {string} data 
 */
Engine.prototype.broadcast = function(data) {
  logger.debug("广播数据给所有的玩家", data)
  let packet = PUtil.roomBroadcast(data)
  this._room.send(this._userList, packet)
}

/**
 * 向指定用户发送一条事件
 * @param {string} userid 接收事件的用户ID
 * @param {string} key 
 * @param {string} value 
 */
Engine.prototype.send = function(userid, key, value) {
  // logger.debug("向玩家:%s 发送数据 %s:%s", userid, key, value)
  let params = {}
  params[key] = value
  let packet = PUtil.roomMsg(params)
  this._room.send(userid, packet)
}

/**
 * 主动关闭房间
 */
Engine.prototype.close = function() {
  // logger.debug("engine 关闭房间:%s", this._room.id)
  this._game.roomMgr.closeRoom(this._room.id)
}

/**
 * 启动定期update函数
 */
Engine.prototype.startupdate = function() {
  this._runUpdateLoop = true
}

/**
 * 结束定期update函数
 */
Engine.prototype.stopupdate = function() {
  this._runUpdateLoop = false
}

/**
 * 处理房间关闭的清理工作
 */
Engine.prototype.onclose = function() {
  // logger.debug("engine 房间:%s 关闭中", this._room.id)
  this.sandbox.engine.onclose()
  this._room.syncEventToSup("engine_close", [])
  if(!this._isSupervisor) {
    this._game.engineData.saveUserToStorage(this._game.id, this._room.id, this._userListPrev)
  }
  this._userList = []
  this._userListPrev = []
  this.sandbox.engine.usernum = 0
}

/**
 * 当收到client消息
 */
Engine.prototype.onClientMsg = function(userId, key, value) {
  // same as this.onuserevent
  if(key == "room.startgame") {
    this.sandbox.engine.onstart()
  } else {
    // logger.debug("用户:%s 操作:%s room owner:%s master:", userId, key, this._room.ownerId, this.sandbox.engine.master)
    this.sandbox.engine.onuserevent(userId, key, value)
    this._room.syncEventToSup("on_client_msg", [userId, key, value])
  }
}

/**
 * 当玩家进入
 * 被 room 调用
 * @param {string} userId 
 */
Engine.prototype.enterRoom = async function(userId) {
  // logger.debug("engine 玩家:%s 进入房间 userList:", userId, this._userList)
  if(this._userList.indexOf(userId) != -1) {
    return false
  }
  // 加载数据
  let data = await this._game.engineData.loadUserFromStorage(userId)
  if(!data) {
    console.log('Engine EnterRoom loadUserFromStorage取用户数据失败',userId)
    return false
  }
  this._userList.push(userId)
  this._userListPrev.push(userId)
  this.sandbox.engine.usernum = this._userList.length
  this.sandbox.engine.onuserin(userId, data)
  return true
}

/**
 * 当玩家离开
 * 由room调用
 */
Engine.prototype.leaveRoom = function(userId) {
  let index = this._userList.indexOf(userId)
  if(index == -1) {
    return false
  }
  this._userList.splice(index, 1)
  this.sandbox.engine.usernum = this._userList.length
  this.sandbox.engine.onuserout(userId)
  this._room.syncEventToSup("leave_room", [this._room.id, userId, 5])
  return true
}

/**
 * 获取房间的用户数
 */
Engine.prototype.getUserCount = function() {
  return this.sandbox.engine.usernum
}


/**
 * 收到逻辑节点的同步事件
 * 由 room 调用
 * @param {*} frameCount 
 * @param {*} type 
 * @param {*} data 
 */
Engine.prototype.recvEventFromLogic = function(frameCount, type, data) {
  if(this._isSupervisor) {
    // logger.debug("监督节点房间:%s 添加待执行的逻辑事件, 类型:%s 值:", this._room.id, type, data)
    this._supervisor.addSyncEvent(frameCount, type, data)
  } else {
    logger.warn("非监督节点收到同步事件! room:", this._room.id)
  }
}

/*******************************
 * internal API
 *******************************/

/**
 * 启动循环
 * @param {int} internal loop的间隔(ms)
 * @param {*} cb
 */
Engine.prototype._startLoop = function(interval, cb) {
  function ontimeout() {
    // logger.debug("engine循环,frameCount", this._frameCount, "userList:", this._userList)
    if(cb) {
      cb()
    }
    setTimeout(ontimeout.bind(this), interval)
  }
  setTimeout(ontimeout.bind(this), interval)
}


/**
 * 初始化成员变量
 */
Engine.prototype._initProperty = function(gameId, config) {
  if(!(config && config.room_define && config.room_define.common)) {
    logger.error("game %s config.json defined invalid!", gameId)
    return false
  }
  let engine = this.sandbox.engine
  let roomDefine = config.room_define.common

  engine.name = this._room.id
  engine.master = this._room.ownerId
  engine.fps = roomDefine.fps
  engine.duration = roomDefine.duration
  engine.userlimit = roomDefine.user_limit
  engine.matchfieldname = roomDefine.match_field_name
  engine.matchrule = roomDefine.match_rule
  engine.usernum = 0

  // 绑定函数
  engine.getusersid = this.getusersid.bind(this)
  engine.getuserdata = this.getuserdata.bind(this)
  engine.saveuserdata = this.saveuserdata.bind(this)
  engine.broadcast = this.broadcast.bind(this)
  engine.send = this.send.bind(this)
  engine.close = this.close.bind(this)
  engine.startupdate = this.startupdate.bind(this)
  engine.stopupdate = this.stopupdate.bind(this)

  this._userList = []
  this._userListPrev = []
  return true
}

/**
 * 对代码进行封装
 */
function _codeWrap(code) {
  let bind = 
`
engine.oncreated = ((typeof oncreated != "undefined") && oncreated) || function(){}
engine.onstart = ((typeof onstart != "undefined") && onstart) || function(){}
engine.onclose = ((typeof onclose != "undefined") && onclose) || function(){}
engine.onuserin = ((typeof onuserin != "undefined") && onuserin) || function(){}
engine.onuserout = ((typeof onuserout != "undefined") && onuserout) || function(){}
engine.onuserevent = ((typeof onuserevent != "undefined") && onuserevent) || function(){}
engine.onupdate = ((typeof onupdate != "undefined") && onupdate) || function(){}
`
  return code + bind
}


module.exports = Engine