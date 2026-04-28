// test/scanUntil.ts

import { BleuIO } from '../src/BleuIO'

const DON_ADDR = '40:48:FD:EB:AA:5D'
const EMS_ADDR = 'AA:AA:AA:AA:AA:AA'

async function main() {
    const central = await BleuIO.open('COM18')

    try {
        await central.ate(false)
        await central.at_central()

        const t0 = Date.now()

        const hit = await central.scanUntilAddress(DON_ADDR, {
            scanSeconds: 3
        })

        const dt = Date.now() - t0

        console.log('hit:', hit)
        console.log(`time(ms): ${dt}`)
    }
    finally {
        await central.close()
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
