# Charli3 Oracles Hackathon

## **Participant Guide**

Welcome to the Charli3 Oracles Hackathon. This guide contains everything you need to make the most of your 3-day build.

---

## Key Timeline

| **Event** | **Date** | **Time** |
| --- | --- | --- |
| **Official Kick Off & Challenges Release** | Thursday April 16, 2026 | 11:00 AM EST |
| Day 1 Live Help Session | Thursday April 16, 2026 | 6:00 PM EST |
| Day 2 Live Help Session | Friday April 17, 2026 | 11:00am EST |
| Day 3 Live Help Session  | Saturday April 18, 2026 | TBD |
| Submission Deadline | Sunday April 19, 2026 | TBD |
| Closing Ceremony + Winners Announced | TBD | TBD |

---

## Prize Pool

<aside>
🏆

**Total Prize Pool: 40,000 ADA** 

*Funded by Project Catalyst and the Cardano Foundation.*

**🏆  Grand Prize**

🥇 **Best Overall** — 20,000 ADA 

The single best project across all tracks.
*Solo or team, any track.*

**🏆  Best in Track**

🥇 **DeFi Track** — 5,000 ADA
🥇 **Real World Settlements Track** - 5,000 ADA
🥇 **Oracle Tooling Track** (Bonus) - 5,000 ADA

**🏆  People's Choice** — 5,000 ADA
Voted by the Cardano community after submissions close.

**Additional perks:** Charli3, Cardano Foundation, and Project Catalyst will run a coordinated spotlight on all hackathon winners.

`Note: Solo or team - prizes go to the project. teams split however they agreed amongst themselves.`  

</aside>

---

## Categories and Challenges

Two + 1 *Bonus* tracks. You may choose any.

<aside>

**Track 1: DeFi Applications & Integrations**

**CHALLENGE:** Demonstrate a financial scenario on Cardano where the outcome depends on verified market data fetched on-chain during the action time.

**IDEAS:**

- Borrowing or lending decision that executes based on a live collateral price
- Trade or swap that settles at a verified market rate at execution
- Liquidation or margin call triggered when an asset price crosses a threshold
- A synthetic asset that mints or redeems based on verified underlying price
</aside>

<aside>

**Track 2:  Real World Settlements

CHALLENGE:** Demonstrate a real-world scenario on Cardano where a fair outcome depends on verified external data fetched on-chain at settlement.

**IDEAS:**

- Insurance payout that releases automatically when oracle data confirms a qualifying event
- Escrow or milestone contract that resolves when oracle data confirms a condition
- Dispute resolution mechanism that uses oracle-verified data as source of truth
</aside>

<aside>

**BONUS TRACK: Oracle Tooling**

**CHALLENGE:** Make it easier for Cardano builders to integrate the MIT open-source pull oracle infrastructure. Lower the friction. Help the next builder ship faster.

**IDEAS:**

- SDK or library for integrating Charli3 pull oracle in a few lines of code
- Sample contracts and integration templates for common patterns
- Developer tooling — CLI, scaffolding, deploy scripts, testing utilities
- Documentation, tutorials, or video walkthroughs that meaningfully lower the barrier
</aside>

---

## Judging Criteria

| **Criteria** |  What judges look for |
| --- | --- |
| Technical Implementation  | Does it work? Is the oracle integrated meaningfully? Code quality and completeness. Did this require solving a difficult technical challenge? |
| Innovation & Creativity | How novel is the approach? Did the builders need to research and develop something previously unavailable? |
| Impact on Cardano | Will this drive on-chain transactions, TVL, or new users to Cardano? Will it improve the ecosystem? |
| Business Growth & Potential | Did the integration unlock a new business concept or grow an existing one? Will it enable real growth on Cardano? |

---

## Participation Rules

- **Solo vs Team — which tier are you in?**
    
    **Solo tier:** individual participants only. You build alone.
    **Team tier:** 2 to 4 members. Maximum 4 developers per team.
    
    You cannot switch tiers after kickoff on April 16.
    
    Looking for teammates? Use #team-formation channel before April 16. Team composition locks at kickoff. No changes after that.
    
- **Eligibility**
    
    Open to individual developers and teams of 2–4. Participants must have registered by April 16th Kick Off. 
    
    Cardano Foundation employees and contractors are welcome to participate, but cannot win prizes.
    
    *Late registrations are not accepted*
    
- **Original Work**
    - All code must be written during the event.
    - Open-source libraries and frameworks are allowed with proper attribution
    - Pre-existing personal work must be declared in your submission README with a clear description of what was built during the event
    - Judges will review GitHub commit history
- **Oracle Requirement**
    - Every submission must use Charli3's pull oracle
    - The oracle integration must be meaningful i.e
        - Without the integration the core capabilities and functionality of the solution would not work.
    - Projects without oracle integration will be disqualified

---

## Discord Server Guide

| **Channel** | **Purpose** |
| --- | --- |
| #rules  | Participation Rules — read this |
| #announcements-hackathon | All official announcements — read this |
| #support-hackathon | Help desk — use tags, search before posting |
| #general-resources | SDK, quick start guide, all docs |
| #team-formation | Solos looking for teammates (open until Kick Off Starts) |
| #👋-introductions-hackathon | Introduce yourself |
| #defi-track | Specific Details + questions and discussion for Track 1 |
| #real-world-track | Specific Details + questions and discussion for Track 2 |
| #day-1-check-in  | Required update post — Day 1 |
| #day-2-check-in  | Required update post — Day 2 |
| #day-3-check-in | Required update post — Day 3 |
| #submission-info | Submission guide and form link |
| #project-submissions | Post your final project card here |
| #winners | Winners announced after closing ceremony |
| #feedback | Post-event survey |

**Note:** *All live sessions (kickoff + Day 1-3 help sessions) happen in* **hackathon-live-stage** *under the Events category. Check the Events tab and mark yourself as Interested.*

---

## Technical Resources

All technical resources for the hackathon are compiled in a dedicated GitHub repository. This repository includes essential materials, documentation, and tools to support your development throughout the event.

*You can access the full collection here as well:*

[https://github.com/Charli3-Official/hackathon-resources](https://github.com/Charli3-Official/hackathon-resources)

Official pull oracle documentation:
[https://docs.charli3.io/oracles/products/pull-oracle/summary](https://docs.charli3.io/oracles/products/pull-oracle/summary)

Full Charli3 docs:
[https://docs.charli3.io/oracles](https://docs.charli3.io/oracles)

Pull Oracle SDK:
[https://github.com/Charli3-Official/charli3-pull-oracle-sdk](https://github.com/Charli3-Official/charli3-pull-oracle-sdk)

Pull Oracle Contracts (on-chain validator code):
[https://github.com/Charli3-Official/charli3-pull-oracle-contracts](https://github.com/Charli3-Official/charli3-pull-oracle-contracts)

Pull Oracle Node:
[https://github.com/Charli3-Official/charli3-pull-oracle-node](https://github.com/Charli3-Official/charli3-pull-oracle-node)

Pull Oracle Client library:
[https://github.com/Charli3-Official/charli3-pull-oracle-client](https://github.com/Charli3-Official/charli3-pull-oracle-client)

## Video Guides

**Charli3 Docs Walkthrough:**
A walkthrough of the documentation structure and where to find what you need
[https://drive.google.com/file/d/1j3nTlpOQX-dJ0-8e0n84D-jDU4p1j_4e/view](https://drive.google.com/file/d/1j3nTlpOQX-dJ0-8e0n84D-jDU4p1j_4e/view?usp=drive_link)

**Oracle Deployment Guide:**
Step-by-step guide to deploying the pull oracle for your project
[https://drive.google.com/file/d/1U77Vt5jjWFxf19MwNKSH3_vvX2hKjcJR/view](https://drive.google.com/file/d/1U77Vt5jjWFxf19MwNKSH3_vvX2hKjcJR/view?usp=drive_link)

---

## Support & Help

Recommended Steps to take:

1. Search existing posts first. In case your question is already answered, that’ll save you some time. 
2. Start your message with the relevant tag:
    1. **[TECHNICAL]:** SDK, contracts, oracle integration, code issues
    2. **[SUBMISSION]:**  form, GitHub, demo video, deadline questions
    3. **[TEAM]:** finding teammates, registering a team, tier changes
    4. **[OTHER]:** anything else
3. **Be specific:** share what you tried, what you expected, and what actually happened
4. Tag *@Charli3 Team* for urgent or build-blocking issues

---

## FAQs

- **Q: Can I work alone or do I need a team?**
    
    **A:** You're required to participate as you registered - either solo or with your registered team. Team composition cannot be changed once the event kicks off. 
    
- **Q: What technical documentation is required?**
    
    **A:** Include setup instructions, architecture overview, and key technical decisions. Make it easy for judges to understand and test.
    
- **Q: How detailed should my daily progress posts be?**
    
    **A:** Share genuine updates about your building process, challenges, and learnings. Authenticity is valued over perfection.
    
- **Q: What if I miss the submission deadline?**
    
    **A:**  The deadline has to be strictly followed with no exceptions.
    Use the 6-hour and 1-hour warnings in #announcements-hackathon
    to make sure you submit in time.