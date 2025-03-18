export interface LoginResultInfo {
  type: number
  token: string
  userId: string
  invitationActivation: boolean
  mobilePhone: string
  email: string
  nickName: string
  color?: string
  ticket?: string
  // 多因素
  authType: 'SingleFactor' | 'Multifactorial'
  // 认证方式
  secondAuthFactor: 'Email' | 'Phone' | 'Captcha'
}

export interface ResponseWrap<T> {
  code: number
  data: T
  message: string
  status: boolean
}
