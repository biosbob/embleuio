// test/connectOnce.ts

import { BleuIO } from '../src/BleuIO'

const EMS_ADDR = '[0]AA:AA:AA:AA:AA:AA'

async function main() {
    const central = await BleuIO.open('COM18')

    try {
        await central.setCentral()

        const t0 = Date.now()
        const lines = await central.connectOnce(EMS_ADDR, 1000)

        console.log('lines:', lines)
        console.log(`time(ms): ${Date.now() - t0}`)
    }
    finally {
        await central.close()
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
