import AES from 'crypto-js/aes'

export function encryptFn(word: string, keyWord: string = 'awKsGlMcdPMEhR1B') {
  const encrypt = AES.encrypt(word, keyWord)
  return encrypt.toString()
}
