import { BleuIO } from '../src/BleuIO'

async function main() {
    const dongle = await BleuIO.open('COM18')

    try {
        await dongle.setCentral()

        const lines = await dongle.at_gapscan(2)
        console.log(lines)
    }
    finally {
        await dongle.close()
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})