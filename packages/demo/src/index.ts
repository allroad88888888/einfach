import AES from 'crypto-js/aes'
import Utf8 from 'crypto-js/enc-utf8'
import type { LoginResultInfo, ResponseWrap } from './type'
import { encryptFn } from './xx'

function aesDecrypt(word: string, keyWord: string = 'awKsGlMcdPMEhR1B') {
  const decrypt = AES.decrypt(word, keyWord)
  return decrypt.toString(Utf8)
}

async function loginWithInfo(data: {
  // 用户名
  username: string
  // 密码
  password: string
}) {
  return fetch('/system-login-api/oauth/login', {
    method: 'post',
    body: JSON.stringify(data),

    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
    },
  }).then((res) => {
    return res.json() as unknown as ResponseWrap<LoginResultInfo>
  })
}

function getQuery(url: string = location.search) {
  return Object.fromEntries(new URLSearchParams(url))
}

function redirectFn(redirectUrl: string, isIframe?: boolean) {
  // return
  if (!isIframe) {
    window.location.href = redirectUrl
  } else {
    window.top?.postMessage(
      {
        action: 'jump',
        info: redirectUrl,
      },
      '*',
    )
  }
}

function main() {
  const query = getQuery()

  if (query.u && query.p) {
    loginWithInfo({
      username: aesDecrypt(query.u),
      password: query.p,
    }).then((res) => {
      if (res?.code === 0) {
        const { origin } = window.location
        const url = query.t ?? `${origin}/system-account/workbench`
        redirectFn(url)
      } else {
        console.error('登录异常')
        // notification.error({
        //   message: '登录异常',
        // });
      }
    })
  }
}

main()

console.log(`encryptFn :${encryptFn('proinnova__0')}`)
