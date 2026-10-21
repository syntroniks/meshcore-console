// MeshCore companion protocol constants, as defined by firmware v1.18.0
// (examples/companion_radio/MyMesh.cpp, src/Packet.h, src/helpers/AdvertDataHelpers.h).

/** Commands, app to radio. The first byte of every outgoing frame. */
export const Cmd = {
  AppStart: 1,
  SendTxtMsg: 2,
  SendChannelTxtMsg: 3,
  GetContacts: 4,
  GetDeviceTime: 5,
  SetDeviceTime: 6,
  SendSelfAdvert: 7,
  SetAdvertName: 8,
  AddUpdateContact: 9,
  SyncNextMessage: 10,
  SetRadioParams: 11,
  SetRadioTxPower: 12,
  ResetPath: 13,
  SetAdvertLatLon: 14,
  RemoveContact: 15,
  ShareContact: 16,
  ExportContact: 17,
  ImportContact: 18,
  Reboot: 19,
  GetBattAndStorage: 20,
  SetTuningParams: 21,
  DeviceQuery: 22,
  ExportPrivateKey: 23,
  ImportPrivateKey: 24,
  SendRawData: 25,
  SendLogin: 26,
  SendStatusReq: 27,
  HasConnection: 28,
  Logout: 29,
  GetContactByKey: 30,
  GetChannel: 31,
  SetChannel: 32,
  SignStart: 33,
  SignData: 34,
  SignFinish: 35,
  SendTracePath: 36,
  SetDevicePin: 37,
  SetOtherParams: 38,
  SendTelemetryReq: 39,
  GetCustomVars: 40,
  SetCustomVar: 41,
  GetAdvertPath: 42,
  GetTuningParams: 43,
  SendBinaryReq: 50,
  FactoryReset: 51,
  SendPathDiscoveryReq: 52,
  SetFloodScopeKey: 54,
  SendControlData: 55,
  GetStats: 56,
  SendAnonReq: 57,
  SetAutoaddConfig: 58,
  GetAutoaddConfig: 59,
  GetAllowedRepeatFreq: 60,
  SetPathHashMode: 61,
  SendChannelData: 62,
  SetDefaultFloodScope: 63,
  GetDefaultFloodScope: 64,
  SendRawPacket: 65,
  RunCliCommand: 66,
} as const

/** Replies, radio to app. Codes below 0x80 answer the most recent command. */
export const Resp = {
  Ok: 0,
  Err: 1,
  ContactsStart: 2,
  Contact: 3,
  EndOfContacts: 4,
  SelfInfo: 5,
  Sent: 6,
  ContactMsgRecv: 7,
  ChannelMsgRecv: 8,
  CurrTime: 9,
  NoMoreMessages: 10,
  ExportContact: 11,
  BattAndStorage: 12,
  DeviceInfo: 13,
  PrivateKey: 14,
  Disabled: 15,
  ContactMsgRecvV3: 16,
  ChannelMsgRecvV3: 17,
  ChannelInfo: 18,
  SignStart: 19,
  Signature: 20,
  CustomVars: 21,
  AdvertPath: 22,
  TuningParams: 23,
  Stats: 24,
  AutoaddConfig: 25,
  AllowedRepeatFreq: 26,
  ChannelDataRecv: 27,
  DefaultFloodScope: 28,
  CliReply: 29,
} as const

/** Unsolicited pushes, radio to app. Codes 0x80 and up. */
export const Push = {
  Advert: 0x80,
  PathUpdated: 0x81,
  SendConfirmed: 0x82,
  MsgWaiting: 0x83,
  RawData: 0x84,
  LoginSuccess: 0x85,
  LoginFail: 0x86,
  StatusResponse: 0x87,
  LogRxData: 0x88,
  TraceData: 0x89,
  NewAdvert: 0x8a,
  TelemetryResponse: 0x8b,
  BinaryResponse: 0x8c,
  PathDiscoveryResponse: 0x8d,
  ControlData: 0x8e,
  ContactDeleted: 0x8f,
  ContactsFull: 0x90,
} as const

export const ErrCode = {
  UnsupportedCmd: 1,
  NotFound: 2,
  TableFull: 3,
  BadState: 4,
  FileIoError: 5,
  IllegalArg: 6,
} as const

export const StatsType = { Core: 0, Radio: 1, Packets: 2 } as const

export const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3, Sensor: 4 } as const

/** Bits of the auto-add config byte (CMD_GET/SET_AUTOADD_CONFIG). */
export const AutoAdd = {
  OverwriteOldest: 0x01,
  Chat: 0x02,
  Repeater: 0x04,
  RoomServer: 0x08,
  Sensor: 0x10,
} as const

/** A contact's out_path_len when no direct path is known (messages go by flood). */
export const OUT_PATH_UNKNOWN = 0xff

/** Size of the firmware's frame buffer (BaseSerialInterface.h). */
export const MAX_FRAME_SIZE = 176

export const ROUTE_TYPE_NAMES = ['transport-flood', 'flood', 'direct', 'transport-direct'] as const

export const PAYLOAD_TYPE_NAMES: Record<number, string> = {
  0x00: 'request',
  0x01: 'response',
  0x02: 'text',
  0x03: 'ack',
  0x04: 'advert',
  0x05: 'group-text',
  0x06: 'group-data',
  0x07: 'anon-request',
  0x08: 'path',
  0x09: 'trace',
  0x0a: 'multipart',
  0x0b: 'control',
  0x0f: 'raw-custom',
}

export const ADV_TYPE_NAMES: Record<number, string> = {
  0: 'none',
  1: 'companion',
  2: 'repeater',
  3: 'room server',
  4: 'sensor',
}

export const ERR_CODE_NAMES: Record<number, string> = {
  1: 'unsupported command',
  2: 'not found',
  3: 'table full',
  4: 'bad state',
  5: 'file I/O error',
  6: 'illegal argument',
}

export function nameOf(table: Record<string, number>, code: number): string {
  for (const [name, value] of Object.entries(table)) {
    if (value === code) return name
  }
  return `0x${code.toString(16).padStart(2, '0')}`
}
