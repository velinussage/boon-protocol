// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import lucode from 'lucode-starlight';

export default defineConfig({
  site: 'https://docs.boonprotocol.com',
  integrations: [
    starlight({
      title: 'Boon Docs',
      description: 'Documentation for Boon, onchain USDC gratitude tipping on Base.',
      favicon: '/favicon.svg',
      logo: {
        light: './src/assets/boon-logo-light.svg',
        dark: './src/assets/boon-logo-dark.svg',
        replacesTitle: true,
      },
      customCss: ['./src/styles/global.css'],
      head: [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..700&display=swap',
          },
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/velinussage/boon-protocol/edit/main/docs',
      },
      lastUpdated: true,
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/velinussage/boon-protocol',
        },
      ],
      plugins: [
        lucode({
          navLinks: [
            { label: 'App', link: 'https://boonprotocol.com' },
            { label: 'API', link: '/api-reference/overview/' },
            { label: 'GitHub', link: 'https://github.com/velinussage/boon-protocol' },
          ],
          footerText: 'Boon is live on Base mainnet and unaudited. Use small amounts.',
        }),
      ],
      // Navigation follows Diátaxis: Start for learning, Use Boon for tasks,
      // Reference for lookup, Learn for concepts, and Project for status.
      sidebar: [
        { label: 'Introduction', link: '/' },
        {
          label: 'Start',
          items: [
            { label: 'Quickstart', link: '/get-started/quickstart/' },
          ],
        },
        {
          label: 'Use Boon',
          items: [
            { label: 'Send a tip', link: '/guides/send-a-tip/' },
            { label: 'Agent sends', link: '/guides/tip-from-agent/' },
            { label: 'Claim', link: '/guides/claim-a-boon/' },
            { label: 'Agent wallet setup', link: '/guides/wallet-ows-setup/' },
            { label: 'Withdraw OWS funds', link: '/guides/wallet-ows-withdraw/' },
            { label: 'Troubleshooting', link: '/guides/troubleshooting/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', link: '/guides/cli-reference/' },
            { label: 'Hosted API', link: '/api-reference/overview/' },
            { label: 'API auth', link: '/api-reference/authentication/' },
            { label: 'x402', link: '/api-reference/x402-protocol/' },
            { label: 'x402 graph', link: '/api-reference/x402-paid-endpoints/' },
            { label: 'Contract addresses', link: '/resources/contract-addresses/' },
            { label: 'Tokenomics', link: '/tokenomics/' },
            { label: 'Agent skill file', link: '/resources/agent-skill-file/' },
            { label: '$BOON burns', link: '/burn/' },
          ],
        },
        {
          label: 'Learn',
          items: [
            { label: 'Overview', link: '/concepts/' },
            { label: 'Settlement', link: '/concepts/escrow-vs-push/' },
            { label: 'Handles', link: '/concepts/canonical-handles/' },
            { label: 'Agent-native recipients', link: '/concepts/agent-recipients/' },
            { label: 'OAuth claims', link: '/concepts/oauth-claim-flow/' },
            { label: 'Private tips', link: '/concepts/private-tips/' },
            { label: 'Private commits', link: '/concepts/private-tip-intents/' },
            { label: 'Attestations', link: '/concepts/attestations/' },
            { label: 'OWS wallet', link: '/concepts/ows-agent-wallet/' },
            { label: 'Subgraph', link: '/concepts/data-layer/' },
          ],
        },
        {
          label: 'Project',
          items: [
            { label: 'Repository', link: '/resources/repository-changelog/' },
            { label: 'Status', link: '/resources/status-disclaimers/' },
          ],
        },
      ],
    }),
  ],
});
