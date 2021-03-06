/**
 * 协议相关的工具类
 */
function ProtocolUtil() {
}


/**
 * 登录成功
 * @param {*} code 
 * @param {*} node_hash_address 
 * @param {*} ip_address 
 * @param {*} port 
 * @param {*} ssl_port 
 */
ProtocolUtil.prototype.userJoined = function (code, node_hash_address, ip_address, port, ssl_port) {
  var packet = {};
  packet.url = 'user.logined';
  packet.params = {};
  packet.params.code = code;
  if(code == 0) {
    packet.params.node_hash_address = node_hash_address
    packet.params.ip_address = ip_address;
    packet.params.port = port;
    packet.params.ssl_port = ssl_port;
  }
  return packet
}

/**
 * 加入房间成功
 * @param {int} code
 * @param {object} room
 */
ProtocolUtil.prototype.roomJoined = function (code, players) {
  var packet = {};
  packet.url = 'room.joined';
  packet.params = {};
  packet.params.code = code;
  if(code == 0) {
    packet.params.room = {}
    packet.params.room.players = players
  }
  return packet
}


/**
 * 玩家离开房间
 */
ProtocolUtil.prototype.user_leave_room = function(){

}


/**
 * 房间内消息
 * @param {*} params 
 */
ProtocolUtil.prototype.roomMsg = function(params) {
  let packet = {}
  packet.url = "room.msg"
  packet.params = params
  return packet
}

/**
 * 房间内广播
 * @param {*} params 
 */
ProtocolUtil.prototype.roomBroadcast= function(data) {
  let packet = {}
  packet.url = "room.broadcast"
  packet.params = {}
  packet.params.data = data
  return packet
}

/**
 * 匹配成功
 * @param {*} serverId 
 * @param {*} ip 
 * @param {*} sslip 
 */
ProtocolUtil.prototype.userToGame = function(gameId, userId, data) {
  let node = data.logic_node
  let userList = data.player_pubkey_list
  let ip = node.ip_address + ":" + node.ws_port
  let sslip = ""

  let packet = {}
  packet.url = "user.togame"
  let params = packet.params = {}
  params.serverid = node.node_hash_address
  params.ip = ip
  params.sslip = sslip
  params.master = app.gameMgr.matchResult.getRoomMaster(data.room_hash)
  params.roomname = data.room_hash
  // FIXME: token添加
  params.token = "fixme-token"
  return packet
}

module.exports = new ProtocolUtil