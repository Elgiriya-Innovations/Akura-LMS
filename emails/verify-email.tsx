import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Text,
} from "@react-email/components";

export function VerifyEmail(props: { name: string; verifyUrl: string }) {
  return (
    <Html>
      <Head />
      <Preview>Confirm your email for Akura</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Confirm your email</Heading>
          <Text style={text}>
            Hi {props.name}, confirm this email address to finish setting up
            your Akura account.
          </Text>
          <Text style={text}>
            <Link href={props.verifyUrl} style={link}>
              Confirm email
            </Link>
          </Text>
          <Text style={muted}>
            If you did not create an Akura account, you can ignore this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const main = {
  backgroundColor: "#F7F8FB",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
};
const container = {
  backgroundColor: "#ffffff",
  margin: "24px auto",
  padding: "24px",
  maxWidth: "520px",
};
const h1 = { color: "#101828", fontSize: "22px", margin: "0 0 16px" };
const text = { color: "#101828", fontSize: "15px", lineHeight: "1.5" };
const link = { color: "#E4761B", fontSize: "15px" };
const muted = { color: "#667085", fontSize: "13px", marginTop: "24px" };
